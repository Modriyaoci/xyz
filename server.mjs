import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mapOpenF1ToBackend } from "./backend-fields.mjs";
import { fetchF1TelemetryState } from "./f1telemetry.mjs";
import { collectSessionFeedRows, completeSessionResultRows } from "./session-feed-rules.mjs";
import {
  DEFAULT_NANA_MAPPING,
  normaliseNanaMapping,
  normaliseNanaSnapshot,
} from "./nana-mapping.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
// Cloud hosts provide PORT; keep F1_PORT for local and existing deployments.
const port = Number(process.env.PORT || process.env.F1_PORT || 4174);
const host = String(process.env.F1_HOST || "127.0.0.1");
const renderNoSessionCache = process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);
const apiBase = "https://api.openf1.org/v1";
const upstreamTimeoutMs = 30000;
const upstreamRequestIntervalMs = 400;
let nextUpstreamRequestAt = 0;
const cacheDir = path.join(root, "work", "openf1_cache");
const fastF1SessionScript = path.join(root, "scripts", "fastf1-session.py");
const fastF1CacheDir = path.join(root, "work", "fastf1_cache");
const fastF1SessionCacheDir = path.join(root, "work", "fastf1_session_cache");
const nanaMappingFile = path.join(root, "work", "nana-mapping.json");
const fastF1CacheVersion = "20260903-fastf1-source-v5";
const fastF1TimeoutMs = Number(process.env.FASTF1_TIMEOUT_MS || 180000);
const fastF1Enabled = process.env.FASTF1_ENABLED !== "0" && process.env.FASTF1_FALLBACK !== "0";
const meetingCatalogFile = path.join(root, "meetings-all.json");
const fastF1MeetingCatalogFile = path.join(root, "fastf1-meetings.json");
const localDutchDir = path.join(root, "work", "openf1_netherlands_2026");
const localMapped = path.join(root, "outputs", "openf1-mapped-result", "netherlands_2026_race_openf1_mapped.json");
const currentStandingsSeason = 2026;
const standingsSeasons = new Set([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, currentStandingsSeason]);
const standingsSeason = (value) => standingsSeasons.has(Number(value)) ? Number(value) : currentStandingsSeason;
const officialStandingsFile = (year = currentStandingsSeason) => path.join(root, `official-standings-${standingsSeason(year)}.json`);
const execFileAsync = promisify(execFile);
const authUsername = String(process.env.F1_AUTH_USERNAME || "nana");
const authSalt = "f1-openf1-local-auth";
const authPassword = String(process.env.F1_AUTH_PASSWORD || "123456");
const authPasswordHash = crypto.scryptSync(authPassword, authSalt, 32);
const liveBridgeToken = String(process.env.LIVE_TIMING_BRIDGE_TOKEN || crypto.createHash("sha256").update(authPasswordHash).digest("hex"));
const dashLiveBridgeToken = String(process.env.DASH_LIVE_TIMING_BRIDGE_TOKEN || crypto.createHash("sha256").update(`dash:${liveBridgeToken}`).digest("hex"));
const authSessions = new Map();
const sessionSyncInFlight = new Map();
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const feedProbeAt = new Map();
const feedProbeIntervalMs = 5 * 60 * 1000;
const fastF1SessionInFlight = new Map();
let fastF1MeetingCatalogPromise = null;
const liveBridges = {
  nana: {
    name: "nana",
    token: liveBridgeToken,
    rawFile: path.join(root, "work", "nana-live-latest.txt"),
    state: null,
    sequence: 0,
    rawWrite: null,
    rawPending: null,
    clients: new Set(),
  },
  dash: {
    name: "dash",
    token: dashLiveBridgeToken,
    rawFile: path.join(root, "work", "dash-live-latest.txt"),
    state: null,
    sequence: 0,
    rawWrite: null,
    rawPending: null,
    clients: new Set(),
  },
};

await fs.mkdir(cacheDir, { recursive: true });
await fs.mkdir(fastF1SessionCacheDir, { recursive: true });
let nanaMapping = normaliseNanaMapping(DEFAULT_NANA_MAPPING);
try {
  nanaMapping = normaliseNanaMapping(JSON.parse(await fs.readFile(nanaMappingFile, "utf8")));
} catch { /* first boot uses the official 2026 car roster */ }

// OpenF1 meeting keys are stable, while session keys are discovered from the
// sessions endpoint. Keep the season directory usable even when the API is
// temporarily unavailable, and replace placeholder sessions after a live fetch.
const roundByMeeting = new Map([
  [1279, 1], [1280, 2], [1281, 3], [1282, 4], [1283, 5], [1284, 6], [1285, 7],
  [1286, 8], [1287, 9], [1288, 10], [1289, 11], [1290, 12], [1291, 13], [1292, 14],
  [1293, 15], [1294, 16], [1295, 17], [1308, 18], [1296, 19], [1297, 20], [1298, 21],
  [1299, 22], [1300, 23], [1301, 24], [1302, 25],
]);
const sprintMeetingKeys = new Set([1280, 1284, 1285, 1289, 1292, 1296]);
const testingMeetingKeys = new Set([1304, 1305]);
const knownSessionKeys = new Map([
  [1281, { "Practice 1": 11246, "Practice 2": 11247, "Practice 3": 11248, Qualifying: 11249, Race: 11253 }],
  [1292, { "Practice 1": 11343, "Sprint Qualifying": 11344, Sprint: 11348, Qualifying: 11349, Race: 11353 }],
  [1293, { "Practice 1": 11354, "Practice 2": 11355, "Practice 3": 11356, Qualifying: 11357, Race: 11361 }],
]);

function sessionTemplates(meetingKey) {
  const key = Number(meetingKey);
  const names = testingMeetingKeys.has(key)
    ? ["Day 1", "Day 2", "Day 3"]
    : sprintMeetingKeys.has(key)
      ? ["Practice 1", "Sprint Qualifying", "Sprint", "Qualifying", "Race"]
      : ["Practice 1", "Practice 2", "Practice 3", "Qualifying", "Race"];
  const known = knownSessionKeys.get(key) || {};
  return names.map((sessionName) => ({
    meeting_key: key,
    session_key: known[sessionName] ?? null,
    session_type: sessionName.startsWith("Practice") ? "Practice" : sessionName.startsWith("Day ") ? "Testing" : ["Sprint", "Race"].includes(sessionName) ? "Race" : "Qualifying",
    session_name: sessionName,
    is_catalog_placeholder: known[sessionName] == null,
  }));
}

function normaliseMeeting(meeting) {
  const key = Number(meeting.meeting_key);
  return { ...meeting, meeting_key: key, round: meeting.round ?? roundByMeeting.get(key) ?? null, sessions: meeting.sessions || sessionTemplates(key) };
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
};

const nanaLiveBridgePaths = new Set([
  "/api/live-timing",
  "/api/live-timing/entry",
  "/api/live-timing/ingest",
  "/api/live-timing/raw",
  "/api/live-timing/stream",
  "/api/livetiming",
  "/api/livetiming/entry",
  "/api/livetiming/ingest",
  "/api/livetiming/raw",
  "/api/livetiming/stream",
]);

const dashLiveBridgePaths = new Set([
  "/api/live-timing/dash",
  "/api/live-timing/dash/entry",
  "/api/live-timing/dash/ingest",
  "/api/live-timing/dash/raw",
  "/api/live-timing/dash/stream",
  "/api/livetiming/dash",
  "/api/livetiming/dash/entry",
  "/api/livetiming/dash/ingest",
  "/api/livetiming/dash/raw",
  "/api/livetiming/dash/stream",
]);

function liveBridgeForPath(pathname) {
  if (dashLiveBridgePaths.has(pathname)) return liveBridges.dash;
  if (nanaLiveBridgePaths.has(pathname)) return liveBridges.nana;
  return null;
}

function liveBridgeTokenFromRequest(req, url) {
  const header = req.headers["x-live-timing-token"] || req.headers["x-livetiming-token"];
  const authorization = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return String(header || authorization || url.searchParams.get("token") || "");
}

function liveBridgeAuthorised(req, url, bridge) {
  return authenticated(req) || liveBridgeTokenFromRequest(req, url) === bridge.token;
}

function liveBridgeBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  return `${protocol}://${req.headers.host || "127.0.0.1:4174"}`;
}

function liveBridgePayload(bridge) {
  if (!bridge.state) return null;
  return bridge.state;
}

function writeLiveBridgeEvent(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function broadcastLiveBridgeState(bridge) {
  const value = liveBridgePayload(bridge);
  if (!value) return;
  for (const client of bridge.clients) {
    try {
      writeLiveBridgeEvent(client.res, "state", value);
    } catch {
      clearInterval(client.heartbeat);
      bridge.clients.delete(client);
    }
  }
}

function openLiveBridgeStream(req, res, bridge) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, must-revalidate",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  res.write(`: ${bridge.name} live-timing bridge connected\n\n`);
  const client = {
    res,
    heartbeat: setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* close handler removes the client */ }
    }, 15000),
  };
  bridge.clients.add(client);
  if (bridge.state) writeLiveBridgeEvent(res, "state", bridge.state);
  req.on("close", () => {
    clearInterval(client.heartbeat);
    bridge.clients.delete(client);
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBackendLiveSnapshot(value) {
  return Boolean(isPlainObject(value) && (
    Array.isArray(value.competitors)
    || isPlainObject(value.winner)
    || isPlainObject(value.fields)
    || Array.isArray(value.messages)
    || isPlainObject(value.extra)
  ));
}

function canonicalBackendCompetitor(row) {
  if (!isPlainObject(row)) return row;
  const { id, team_id: teamId, pitstop, ...canonical } = row;
  const driverId = row._id ?? id;
  const teamuid = row.teamuid ?? teamId;
  const pitstopCount = row.pitstop_count ?? pitstop;
  if (driverId !== null && driverId !== undefined && driverId !== "") canonical._id = driverId;
  if (teamuid !== null && teamuid !== undefined && teamuid !== "") canonical.teamuid = teamuid;
  if (pitstopCount !== null && pitstopCount !== undefined && pitstopCount !== "") canonical.pitstop_count = pitstopCount;
  return canonical;
}

function canonicalBackendSnapshot(value) {
  const data = { ...value };
  if (isPlainObject(data.winner)) data.winner = canonicalBackendCompetitor(data.winner);
  if (Array.isArray(data.competitors)) data.competitors = data.competitors.map(canonicalBackendCompetitor);
  delete data.mapped;
  return data;
}

function livePayloadKind(value) {
  const explicit = value?.live_bridge?.payload_kind;
  if (explicit) return explicit;
  if (isBackendLiveSnapshot(value) && !value?.mapped) return "backend";
  if (value?.mapped || value?.session || value?.meeting) return "session";
  return "generic";
}

function liveCompetitorKey(row) {
  const id = row?._id ?? row?.id;
  if (id !== null && id !== undefined && id !== "") return `id:${id}`;
  const car = row?.car_number;
  return car === null || car === undefined || car === "" ? null : `car:${car}`;
}

function mergeLiveCompetitors(previous, incoming) {
  const merged = new Map();
  const previousWithoutKey = [];
  const incomingWithoutKey = [];
  for (const row of (Array.isArray(previous) ? previous : [])) {
    const key = liveCompetitorKey(row);
    if (!key) {
      previousWithoutKey.push(row);
      continue;
    }
    merged.set(key, row);
  }
  for (const row of (Array.isArray(incoming) ? incoming : [])) {
    const key = liveCompetitorKey(row);
    if (!key) {
      incomingWithoutKey.push(row);
      continue;
    }
    const existing = merged.get(key);
    merged.set(key, existing && isPlainObject(row) ? mergeLiveValue(existing, row) : row);
  }
  const withoutKey = [];
  for (let index = 0; index < Math.max(previousWithoutKey.length, incomingWithoutKey.length); index += 1) {
    const oldRow = previousWithoutKey[index];
    const newRow = incomingWithoutKey[index];
    withoutKey.push(oldRow && isPlainObject(newRow) ? mergeLiveValue(oldRow, newRow) : newRow ?? oldRow);
  }
  return [...merged.values(), ...withoutKey].sort((left, right) => {
    const leftPosition = Number(left?.position);
    const rightPosition = Number(right?.position);
    return (Number.isFinite(leftPosition) ? leftPosition : 999) - (Number.isFinite(rightPosition) ? rightPosition : 999)
      || Number(left?.car_number || 0) - Number(right?.car_number || 0);
  });
}

function liveMessageKey(row) {
  if (!isPlainObject(row)) return JSON.stringify(row);
  const identity = row._id ?? row.id ?? row.uuid;
  if (identity !== null && identity !== undefined && identity !== "") return `id:${identity}`;
  const timestamp = row.utc ?? row.date ?? row.timestamp;
  if (timestamp !== null && timestamp !== undefined && timestamp !== "") {
    return `time:${timestamp}|lap:${row.lap ?? row.lap_number ?? ""}`;
  }
  return [row.utc ?? row.date ?? "", row.lap ?? row.lap_number ?? "", row.text_en ?? row.message ?? "", row.text_zh ?? ""].join("|");
}

function mergeLiveMessages(previous, incoming) {
  const merged = new Map();
  for (const row of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    merged.set(liveMessageKey(row), row);
  }
  return [...merged.values()];
}

function liveArrayItemKey(row) {
  if (!isPlainObject(row)) return null;
  for (const field of ["_id", "id", "uuid", "key"]) {
    const value = row[field];
    if (value !== null && value !== undefined && value !== "") return `${field}:${value}`;
  }

  const driver = ["driver_number", "driver_id", "car_number"].find((field) => {
    const value = row[field];
    return value !== null && value !== undefined && value !== "";
  });
  const sequence = [
    "lap_number", "lap", "stint_number", "sector", "mini_sector", "global_mini_sector",
    "utc", "date", "date_start", "timestamp",
  ].find((field) => {
    const value = row[field];
    return value !== null && value !== undefined && value !== "";
  });
  if (driver && sequence) return `${driver}:${row[driver]}|${sequence}:${row[sequence]}`;
  if (sequence) return `${sequence}:${row[sequence]}`;
  return null;
}

function mergeLiveArray(previous, incoming) {
  // Nana sends partial snapshots. An empty array means that this field was not
  // included in this update, so retain the last non-empty value.
  if (!incoming.length) return Array.isArray(previous) ? previous : incoming;
  if (!Array.isArray(previous) || !previous.length) return incoming;

  const previousKeys = previous.map(liveArrayItemKey);
  const incomingKeys = incoming.map(liveArrayItemKey);
  if (incoming.every((row, index) => isPlainObject(row) && incomingKeys[index])) {
    const merged = new Map();
    previous.forEach((row, index) => {
      const itemKey = previousKeys[index];
      if (itemKey) merged.set(itemKey, row);
    });
    incoming.forEach((row, index) => {
      const itemKey = incomingKeys[index];
      const existing = merged.get(itemKey);
      merged.set(itemKey, existing && isPlainObject(existing) ? mergeLiveValue(existing, row) : row);
    });
    const unkeyedPrevious = previous.filter((_, index) => !previousKeys[index]);
    const unkeyedIncoming = incoming.filter((_, index) => !incomingKeys[index]);
    const unkeyed = [];
    for (let index = 0; index < Math.max(unkeyedPrevious.length, unkeyedIncoming.length); index += 1) {
      const oldRow = unkeyedPrevious[index];
      const newRow = unkeyedIncoming[index];
      unkeyed.push(oldRow && isPlainObject(newRow) ? mergeLiveValue(oldRow, newRow) : newRow ?? oldRow);
    }
    return [...merged.values(), ...unkeyed].filter((row) => row !== undefined);
  }

  // For records without a stable ID (for example a tire-history row), merge by
  // position and retain trailing rows that were not part of this update.
  const merged = previous.slice();
  incoming.forEach((row, index) => {
    merged[index] = isPlainObject(merged[index]) && isPlainObject(row)
      ? mergeLiveValue(merged[index], row)
      : row;
  });
  return merged;
}

function mergeLiveValue(previous, incoming, key = "") {
  if (Array.isArray(incoming)) {
    if (key === "competitors") return mergeLiveCompetitors(previous, incoming);
    if (key === "messages" || key === "race_control") return mergeLiveMessages(previous, incoming);
    return mergeLiveArray(previous, incoming);
  }
  // A null value in a partial snapshot represents an unavailable field. Keep
  // an already-known value, while preserving null on the first snapshot.
  if (incoming === null || incoming === undefined) return previous === undefined ? incoming : previous;
  if (!isPlainObject(incoming)) return incoming;
  const base = isPlainObject(previous) ? previous : {};
  const merged = { ...base };
  for (const [childKey, value] of Object.entries(incoming)) {
    merged[childKey] = mergeLiveValue(base[childKey], value, childKey);
  }
  return merged;
}

function mergeLiveBridgeSnapshot(previous, incoming) {
  if (!isPlainObject(previous)) return incoming;
  const previousId = previous.id;
  const incomingId = incoming.id;
  if (previousId !== null && previousId !== undefined && incomingId !== null && incomingId !== undefined && String(previousId) !== String(incomingId)) {
    return incoming;
  }
  const previousKind = livePayloadKind(previous);
  const incomingKind = livePayloadKind(incoming);
  if (previousKind !== "generic" && incomingKind !== "generic" && previousKind !== incomingKind) return incoming;
  return mergeLiveValue(previous, incoming);
}

function parsePythonLiteral(source) {
  const text = String(source || "");
  let index = text.indexOf("{");
  if (index < 0) throw new Error("文件中没有找到实时数据对象");
  const skipSpace = () => { while (/\s/.test(text[index] || "")) index += 1; };
  const parseString = () => {
    const quote = text[index++];
    let value = "";
    while (index < text.length) {
      const char = text[index++];
      if (char === quote) return value;
      if (char !== "\\") {
        value += char;
        continue;
      }
      if (index >= text.length) throw new Error("字符串转义不完整");
      const escaped = text[index++];
      const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
      if (Object.prototype.hasOwnProperty.call(simple, escaped)) value += simple[escaped];
      else if (escaped === "u" || escaped === "x") {
        const length = escaped === "u" ? 4 : 2;
        const hex = text.slice(index, index + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Error("字符串编码无效");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += length;
      } else value += escaped;
    }
    throw new Error("字符串没有结束引号");
  };
  const parseNumber = () => {
    const match = text.slice(index).match(/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error(`无法解析数字（位置 ${index}）`);
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("数字超出可用范围");
    return value;
  };
  const parseValue = () => {
    skipSpace();
    const char = text[index];
    if (char === "'" || char === '"') return parseString();
    if (char === "{") {
      index += 1;
      const value = {};
      skipSpace();
      if (text[index] === "}") { index += 1; return value; }
      while (index < text.length) {
        const key = parseValue();
        skipSpace();
        if (text[index++] !== ":") throw new Error(`字典字段缺少冒号（位置 ${index - 1}）`);
        value[String(key)] = parseValue();
        skipSpace();
        if (text[index] === "}") { index += 1; return value; }
        if (text[index++] !== ",") throw new Error(`字典字段缺少逗号（位置 ${index - 1}）`);
      }
      throw new Error("字典没有结束括号");
    }
    if (char === "[") {
      index += 1;
      const value = [];
      skipSpace();
      if (text[index] === "]") { index += 1; return value; }
      while (index < text.length) {
        value.push(parseValue());
        skipSpace();
        if (text[index] === "]") { index += 1; return value; }
        if (text[index++] !== ",") throw new Error(`列表字段缺少逗号（位置 ${index - 1}）`);
      }
      throw new Error("列表没有结束括号");
    }
    for (const [literal, value] of [["None", null], ["True", true], ["False", false]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return value; }
    }
    return parseNumber();
  };
  const value = parseValue();
  if (!isPlainObject(value)) throw new Error("文件中的实时数据必须是对象");
  return value;
}

function multipartFileText(text, contentType) {
  const boundary = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("文件上传缺少 multipart boundary");
  const parts = text.split(`--${boundary}`);
  const part = parts.find((value) => /content-disposition:[^\r\n]*(?:filename=|name="(?:file|data|payload)")/i.test(value));
  if (!part) throw new Error("文件上传中没有找到数据文件");
  const separator = part.search(/\r?\n\r?\n/);
  if (separator < 0) throw new Error("文件上传内容格式无效");
  const headerLength = part.slice(separator).match(/^\r?\n\r?\n/)?.[0].length || 0;
  return part.slice(separator + headerLength).replace(/\r?\n$/, "");
}

async function readLiveBridgeBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      const error = new Error("实时快照超过 8 MB 限制");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const contentType = String(req.headers["content-type"] || "");
  let text = Buffer.concat(chunks).toString("utf8");
  if (/multipart\/form-data/i.test(contentType)) text = multipartFileText(text, contentType);
  try {
    return { value: JSON.parse(text), rawText: text };
  } catch {
    try {
      return { value: parsePythonLiteral(text), rawText: text };
    } catch (pythonError) {
      pythonError.rawText = text;
      throw pythonError;
    }
  }
}

async function ingestLiveBridgeState(req, res, bridge) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024 * 1024) {
    return json(res, 413, { error: "实时快照超过 8 MB 限制" });
  }
  let body;
  try {
    body = await readLiveBridgeBody(req);
  } catch (error) {
    if (error.rawText) await cacheLatestLiveBridgeRaw(bridge, error.rawText);
    return json(res, error.status || 400, { error: error.message || "实时数据文件格式无效" });
  }
  await cacheLatestLiveBridgeRaw(bridge, body.rawText);
  const incomingBody = body.value;
  const incoming = incomingBody?.data && typeof incomingBody.data === "object" && !Array.isArray(incomingBody.data) ? incomingBody.data : incomingBody;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return json(res, 400, { error: "请求体必须是实时快照 JSON" });
  }
  const receivedAt = new Date().toISOString();
  let data = { ...incoming, live: true, fetched_at: receivedAt };
  // A Nana backend snapshot can contain fields named like OpenF1 feeds (for
  // example laps or weather). Only an explicit session/mapped envelope should
  // force the legacy conversion; otherwise partial backend snapshots stay in
  // the backend contract and can be merged incrementally.
  const legacySessionEnvelope = Boolean(data.session || data.meeting || data.mapped)
    || (!isBackendLiveSnapshot(data) && sessionArrayFields.some((field) => Array.isArray(data[field])));
  let payloadKind = "generic";
  if (legacySessionEnvelope) {
    normaliseSessionData(data);
    data.mapped = mapOpenF1ToBackend(data, data.mapped);
    payloadKind = "session";
  } else if (isBackendLiveSnapshot(data)) {
    data = canonicalBackendSnapshot(normaliseNanaSnapshot(data, nanaMapping));
    payloadKind = "backend";
  }
  bridge.sequence += 1;
  bridge.state = mergeLiveBridgeSnapshot(bridge.state, {
    ...data,
    source_name: bridge.name,
    data_source: "external-live-timing",
    source_session: "external-live-timing",
    live_bridge: {
      sequence: bridge.sequence,
      received_at: receivedAt,
      source: "external-live-timing",
      payload_kind: payloadKind,
    },
  });
  broadcastLiveBridgeState(bridge);
  return json(res, 200, {
    ok: true,
    source_name: bridge.name,
    source: "external-live-timing",
    sequence: bridge.sequence,
    received_at: receivedAt,
  });
}

function liveBridgeEntry(req, bridge) {
  const base = liveBridgeBaseUrl(req);
  const token = encodeURIComponent(bridge.token);
  const apiPath = bridge.name === "dash" ? "/api/live-timing/dash" : "/api/live-timing";
  return {
    ok: true,
    source_name: bridge.name,
    source: "external-live-timing",
    memory_only: true,
    raw_cache: { latest_only: true, max_bytes: 8 * 1024 * 1024, ephemeral: true },
    ingest: {
      method: "POST",
      url: `${base}${apiPath}/ingest?token=${token}`,
      header: "X-Live-Timing-Token",
    },
    state: {
      method: "GET",
      url: `${base}${apiPath}?token=${token}`,
    },
    raw: {
      method: "GET",
      url: `${base}${apiPath}/raw?token=${token}`,
      content_type: "text/plain",
      latest_only: true,
    },
    stream: {
      method: "GET",
      url: `${base}${apiPath}/stream?token=${token}`,
      content_type: "text/event-stream",
    },
    sequence: bridge.sequence,
    received_at: bridge.state?.live_bridge?.received_at || null,
  };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const exists = async (file) => fs.access(file).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let meetingCatalogPromise = null;

async function meetingCatalog() {
  if (!meetingCatalogPromise) {
    meetingCatalogPromise = readJson(meetingCatalogFile).catch(() => ({ seasons: [], meetings: [] }));
  }
  return meetingCatalogPromise;
}

async function catalogMeetings(year) {
  const payload = await meetingCatalog();
  return (Array.isArray(payload.meetings) ? payload.meetings : [])
    .filter((meeting) => Number(meeting.year) === Number(year));
}

async function catalogSessions(meetingKey) {
  const payload = await meetingCatalog();
  const meeting = (Array.isArray(payload.meetings) ? payload.meetings : [])
    .find((item) => Number(item.meeting_key) === Number(meetingKey));
  return Array.isArray(meeting?.sessions) ? meeting.sessions : [];
}

async function seasons(source = "openf1") {
  if (normaliseDataSource(source) === "fastf1") return { data: await fastF1Seasons(), source: "fastf1-catalog" };
  const payload = await meetingCatalog();
  const listed = Array.isArray(payload.seasons) ? payload.seasons : [];
  const derived = (Array.isArray(payload.meetings) ? payload.meetings : []).map((meeting) => meeting.year);
  return { data: [...new Set([...listed, ...derived].map(Number).filter(Number.isInteger))].sort((a, b) => b - a), source: "catalog" };
}
async function writeJsonAtomic(file, value) {
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(value, null, 2));
    await fs.rename(tempFile, file);
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

function cacheLatestLiveBridgeRaw(bridge, text) {
  // Keep at most one pending value. If writes take longer than the push
  // interval, newer raw data supersedes the pending value instead of forming a
  // queue of full request bodies in memory.
  bridge.rawPending = String(text || "");
  if (bridge.rawWrite) return bridge.rawWrite;
  bridge.rawWrite = (async () => {
    while (bridge.rawPending !== null) {
      const value = bridge.rawPending;
      bridge.rawPending = null;
      const tempFile = `${bridge.rawFile}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(tempFile, value, "utf8");
        await fs.rename(tempFile, bridge.rawFile);
      } catch (error) {
        // Raw capture is diagnostic; a filesystem failure must not reject a
        // valid Nana update or disconnect the live stream.
        console.error(`${bridge.name} 原始数据缓存失败：${error.message || error}`);
      } finally {
        await fs.rm(tempFile, { force: true }).catch(() => {});
      }
    }
  })().finally(() => {
    bridge.rawWrite = null;
  });
  return bridge.rawWrite;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function authenticated(req) {
  const token = parseCookies(req).f1_session;
  const expires = authSessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) { authSessions.delete(token); return false; }
  return true;
}

function passwordMatches(password) {
  const candidate = crypto.scryptSync(String(password || ""), authSalt, 32);
  return crypto.timingSafeEqual(candidate, authPasswordHash);
}

function authCookie(token, maxAge = 8 * 60 * 60) {
  return `f1_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

async function fetchOpenF1(endpoint) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    const requestAt = Math.max(now, nextUpstreamRequestAt);
    nextUpstreamRequestAt = requestAt + upstreamRequestIntervalMs;
    if (requestAt > now) await sleep(requestAt - now);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    let response;
    try {
      response = await fetch(`${apiBase}${endpoint}`, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (attempt < 1) { await sleep(800); continue; }
      if (error?.name === "AbortError") throw new Error(`数据源请求超时（${upstreamTimeoutMs / 1000}秒） for ${endpoint}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) return response.json();
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    if (retryable && attempt < 1) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Math.min(3000, Math.max(700, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
      continue;
    }
    const error = new Error(`数据源 ${response.status} for ${endpoint}`);
    error.status = response.status;
    throw error;
  }
  throw new Error(`数据源请求失败 for ${endpoint}`);
}

async function resolveFastF1Python() {
  if (process.env.FASTF1_PYTHON) return process.env.FASTF1_PYTHON;
  const bundled = path.join(root, "work", "fastf1-venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  return await exists(bundled) ? bundled : "python3";
}

function normaliseDataSource(value) {
  return String(value || "openf1").toLowerCase() === "fastf1" ? "fastf1" : "openf1";
}

async function fastF1Catalog() {
  if (!fastF1MeetingCatalogPromise) {
    fastF1MeetingCatalogPromise = readJson(fastF1MeetingCatalogFile).catch(() => ({ seasons: [], meetings: [] }));
  }
  return fastF1MeetingCatalogPromise;
}

async function fastF1Meetings(year) {
  const payload = await fastF1Catalog();
  return (Array.isArray(payload.meetings) ? payload.meetings : [])
    .filter((meeting) => Number(meeting.year) === Number(year));
}

async function fastF1Sessions(meetingKey) {
  const payload = await fastF1Catalog();
  const meeting = (Array.isArray(payload.meetings) ? payload.meetings : [])
    .find((item) => Number(item.meeting_key) === Number(meetingKey));
  return Array.isArray(meeting?.sessions) ? meeting.sessions : [];
}

async function fastF1Seasons() {
  const payload = await fastF1Catalog();
  const listed = Array.isArray(payload.seasons) ? payload.seasons : [];
  const derived = (Array.isArray(payload.meetings) ? payload.meetings : []).map((meeting) => meeting.year);
  return [...new Set([...listed, ...derived].map(Number).filter(Number.isInteger))].sort((a, b) => b - a);
}

function compactProcessOutput(value, limit = 4000) {
  const text = String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function parseFastF1ProcessError(error) {
  const stdout = compactProcessOutput(error?.stdout);
  const stderr = compactProcessOutput(error?.stderr);
  let payload = null;
  const candidates = [...stdout.split(/\r?\n/).reverse(), stdout].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        payload = parsed;
        break;
      }
    } catch { /* FastF1 may write ordinary log lines before its JSON error */ }
  }
  const reasons = [];
  if (payload?.error) reasons.push(String(payload.error));
  if (error?.killed || error?.signal) reasons.push(`进程被终止${error.signal ? `（${error.signal}）` : ""}`);
  if (error?.code === "ETIMEDOUT") reasons.push(`执行超时（${Math.round(fastF1TimeoutMs / 1000)}秒）`);
  if (!reasons.length && stderr) reasons.push(stderr.split(/\r?\n/).filter(Boolean).at(-1));
  if (!reasons.length && error?.message) reasons.push(String(error.message));
  return {
    message: `FastF1 读取失败：${[...new Set(reasons)].join("；") || "Python 进程异常退出"}`,
    diagnostic: compactProcessOutput([
      `code=${error?.code ?? "unknown"} signal=${error?.signal ?? "none"} killed=${Boolean(error?.killed)}`,
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : "",
    ].filter(Boolean).join("\n"), 8000),
  };
}

async function fetchFastF1Session(session, meetingKey, sessionKey) {
  if (!fastF1Enabled) throw new Error("FastF1 数据源已关闭（FASTF1_ENABLED=0）");
  const year = Number(session?.year);
  const event = String(session?.meeting_name || session?.country_name || "").trim();
  if (!Number.isInteger(year) || !event) throw new Error("缺少 FastF1 所需的赛季或分站信息");
  const python = await resolveFastF1Python();
  const transientCacheDir = renderNoSessionCache && !process.env.FASTF1_CACHE_DIR
    ? await fs.mkdtemp(path.join(root, "work", "fastf1-run-"))
    : null;
  const env = {
    ...process.env,
    FASTF1_CACHE_DIR: process.env.FASTF1_CACHE_DIR || transientCacheDir || fastF1CacheDir,
  };
  const args = [
    fastF1SessionScript,
    "--year", String(year),
    "--event", event,
    "--session-name", String(session.session_name || "Race"),
    "--fastf1-session-name", String(session.fastf1_session_name || session.session_name || "Race"),
    "--session-code", String(session.fastf1_session_code || ""),
    "--meeting-key", String(meetingKey),
    "--session-key", String(sessionKey),
  ];
  let stdout;
  try {
    try {
      ({ stdout } = await execFileAsync(python, args, {
        cwd: root,
        env,
        timeout: fastF1TimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      const failure = parseFastF1ProcessError(error);
      console.error(`[FastF1] ${year} ${event} ${session.session_name || "Race"} failed\n${failure.diagnostic}`);
      throw new Error(failure.message, { cause: error });
    }
  } finally {
    if (transientCacheDir) await fs.rm(transientCacheDir, { recursive: true, force: true }).catch(() => {});
  }
  let result;
  try { result = JSON.parse(String(stdout || "").trim()); } catch { throw new Error("FastF1 返回格式无效"); }
  if (!result?.ok || !result.session || !Array.isArray(result.drivers)) throw new Error(result?.error || "FastF1 未返回完整会话数据");
  return result;
}

async function fastF1SessionData(meetingKey, sessionKey, { force = false } = {}) {
  const requestedMeetingKey = Number(meetingKey);
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedMeetingKey) || !Number.isInteger(requestedSessionKey)) {
    throw new Error("请选择有效的 FastF1 分站和节点");
  }
  const cacheFile = path.join(fastF1SessionCacheDir, `session_${requestedSessionKey}.json`);
  if (!renderNoSessionCache && await exists(cacheFile)) {
    try {
      const cached = normaliseSessionData(await readJson(cacheFile));
      if (!force && cached.cache_version === fastF1CacheVersion && sessionCacheHealthy(cached, requestedSessionKey)) {
        cached.data_source = "fastf1";
        cached.cache_version = fastF1CacheVersion;
        cached.mapped = mapOpenF1ToBackend(cached, null);
        await writeJsonAtomic(cacheFile, cached);
        return { data: cached, source: "fastf1-cache" };
      }
    } catch { /* regenerate an incomplete or corrupt FastF1 snapshot */ }
  }
  const sessionList = await fastF1Sessions(requestedMeetingKey);
  const session = sessionList.find((row) => Number(row.session_key) === requestedSessionKey);
  if (!session) throw new Error("找不到对应 FastF1 会话");
  let task = fastF1SessionInFlight.get(requestedSessionKey);
  if (!task || force) {
    task = fetchFastF1Session(session, requestedMeetingKey, requestedSessionKey);
    fastF1SessionInFlight.set(requestedSessionKey, task);
    task.finally(() => {
      if (fastF1SessionInFlight.get(requestedSessionKey) === task) fastF1SessionInFlight.delete(requestedSessionKey);
    }).catch(() => {});
  }
  const result = await task;
  const data = {
    ...result,
    data_source: "fastf1",
    source_session: "fastf1",
    cache_version: fastF1CacheVersion,
  };
  normaliseSessionData(data);
  data.mapped = mapOpenF1ToBackend(data, null);
  if (!sessionCacheHealthy(data, requestedSessionKey)) throw new Error("FastF1 返回的数据不完整，缓存未更新");
  data.synced_at = new Date().toISOString();
  if (!renderNoSessionCache) await writeJsonAtomic(cacheFile, data);
  return { data, source: "fastf1", cache: !renderNoSessionCache };
}

async function cachedJson(file, endpoint, fallback, { preferFallback = false } = {}) {
  if (await exists(file)) return { data: await readJson(file), source: "cache" };
  if (preferFallback && fallback) {
    await writeJsonAtomic(file, fallback);
    return { data: fallback, source: "local" };
  }
  try {
    const data = await fetchOpenF1(endpoint);
    await writeJsonAtomic(file, data);
    return { data, source: "openf1" };
  } catch (error) {
    if (fallback) return { data: fallback, source: "local" };
    throw error;
  }
}

async function meetings(year, source = "openf1") {
  if (normaliseDataSource(source) === "fastf1") {
    return { data: await fastF1Meetings(year), source: "fastf1-catalog" };
  }
  const localFile = path.join(cacheDir, `meetings_${year}.json`);
  const catalogRows = await catalogMeetings(year);
  const result = catalogRows.length
    ? { data: catalogRows, source: "catalog" }
    : await cachedJson(localFile, `/meetings?year=${encodeURIComponent(year)}`, null);
  result.data = Array.isArray(result.data) ? await Promise.all(result.data.map(async (meeting) => {
    const normalised = normaliseMeeting(meeting);
    const sessionFile = path.join(cacheDir, `sessions_${normalised.meeting_key}.json`);
    if (await exists(sessionFile)) {
      try {
        const cachedSessions = await readJson(sessionFile);
        if (Array.isArray(cachedSessions) && cachedSessions.length) normalised.sessions = cachedSessions;
      } catch { /* keep the catalog template */ }
    }
    return normalised;
  })) : [];
  return result;
}

async function sessions(meetingKey, source = "openf1") {
  if (normaliseDataSource(source) === "fastf1") {
    const data = await fastF1Sessions(meetingKey);
    return { data, source: "fastf1-catalog" };
  }
  const key = Number(meetingKey);
  const cacheFile = path.join(cacheDir, `sessions_${key}.json`);
  if (await exists(cacheFile)) {
    const cached = await readJson(cacheFile);
    return { data: Array.isArray(cached) ? cached : [], source: "cache" };
  }
  const catalogRows = await catalogSessions(key);
  if (catalogRows.length) return { data: catalogRows, source: "catalog" };
  const localFile = path.join(localDutchDir, "sessions.json");
  const localFallback = key === 1292 && await exists(localFile) ? await readJson(localFile) : null;
  if (localFallback) {
    await writeJsonAtomic(cacheFile, localFallback);
    return { data: localFallback, source: "local" };
  }
  try {
    const data = await fetchOpenF1(`/sessions?meeting_key=${encodeURIComponent(key)}`);
    await writeJsonAtomic(cacheFile, data);
    return { data, source: "openf1" };
  } catch (error) {
    const fallback = sessionTemplates(key);
    if (fallback.length) return { data: fallback, source: "catalog", error: error.message };
    throw error;
  }
}

async function officialStandings(year = currentStandingsSeason) {
  const file = officialStandingsFile(year);
  if (!(await exists(file))) throw new Error("年度排名快照尚未生成");
  const data = await readJson(file);
  if (!Array.isArray(data.drivers) || !Array.isArray(data.teams)) throw new Error("年度排名快照格式不完整");
  return { data, source: "local" };
}

async function syncOfficialStandings() {
  try {
    await execFileAsync(process.execPath, [path.join(root, "scripts", "sync-official-standings.mjs"), "2026", "manual"], { cwd: root, timeout: 120000 });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || "官网快照同步失败";
    try {
      const current = await officialStandings(currentStandingsSeason);
      const previous = current.data.sync_status?.last_success_at || current.data.captured_at || null;
      return {
        data: {
          ...current.data,
          sync_status: {
            status: "failed",
            trigger: "manual",
            attempted_at: new Date().toISOString(),
            last_success_at: previous,
            last_automatic_at: current.data.sync_status?.last_automatic_at || null,
            last_manual_at: current.data.sync_status?.last_manual_at || null,
            error: `年度排名同步失败：${detail}`,
          },
        },
        source: "local",
        sync_failed: true,
      };
    } catch {
      throw new Error(`年度排名同步失败：${detail}`);
    }
  }
  return officialStandings(currentStandingsSeason);
}

async function localSessionData(meetingKey, sessionKey) {
  if (Number(meetingKey) !== 1292) return null;
  const files = ["drivers.json", "session_result.json", "laps.json", "pit.json", "position.json", "intervals_race.json", "stints.json", "race_control.json", "weather.json"];
  const available = await Promise.all(files.map((name) => exists(path.join(localDutchDir, name))));
  if (!available.every(Boolean)) return null;
  const values = await Promise.all(files.map((name) => readJson(path.join(localDutchDir, name))));
  const sessionsData = await readJson(path.join(localDutchDir, "sessions.json"));
  const mapped = Number(sessionKey) === 11353 && await exists(localMapped) ? await readJson(localMapped) : null;
  const data = { meeting: { meeting_key: Number(meetingKey), country_name: "Netherlands", location: "Zandvoort", meeting_name: "Dutch Grand Prix" }, session: sessionsData.find((row) => Number(row.session_key) === Number(sessionKey)) || null, mapped };
  files.forEach((name, index) => { const key = name.replace(/\.json$/, ""); data[key] = values[index].filter ? values[index].filter((row) => Number(row.session_key) === Number(sessionKey)) : values[index]; });
  return data;
}

async function mergeDriverRoster(meetingKey, data) {
  const byNumber = new Map((Array.isArray(data.drivers) ? data.drivers : [])
    .filter((driver) => Number.isFinite(Number(driver.driver_number)))
    .map((driver) => [Number(driver.driver_number), driver]));
  const raceSessionsFile = path.join(cacheDir, `sessions_${Number(meetingKey)}.json`);
  if (await exists(raceSessionsFile)) {
    try {
      const meetingSessions = await readJson(raceSessionsFile);
      const race = (Array.isArray(meetingSessions) ? meetingSessions : [])
        .filter((item) => item.session_name === "Race")
        .sort((a, b) => Date.parse(b.date_start || 0) - Date.parse(a.date_start || 0))[0];
      const raceCache = race && path.join(cacheDir, `session_${race.session_key}.json`);
      if (raceCache && await exists(raceCache)) {
        const raceData = await readJson(raceCache);
        for (const driver of Array.isArray(raceData.drivers) ? raceData.drivers : []) {
          const number = Number(driver.driver_number);
          const current = byNumber.get(number);
          const placeholder = !current?.full_name || /^车手\s*\d+$/i.test(String(current.full_name));
          // Only repair a placeholder already present in this session. A driver
          // absent from the current session must not be imported from the race.
          if (current && placeholder) byNumber.set(number, { ...driver, meeting_key: Number(meetingKey), session_key: Number(data.session?.session_key) });
        }
      }
    } catch { /* keep the current session roster */ }
  }
  data.drivers = Array.from(byNumber.values()).sort((a, b) => Number(a.driver_number) - Number(b.driver_number));
  return data;
}

const sessionArrayFields = ["drivers", "session_result", "laps", "pit", "position", "intervals", "stints", "race_control", "weather"];

function stripTyreAgeFields(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.stints)) return data;
  data.stints = data.stints.map((stint) => {
    const { tyre_age_at_start, tyre_age, tire_age_at_start, tire_age, ...withoutAge } = stint || {};
    return withoutAge;
  });
  return data;
}

function stripStartingGridFields(data) {
  if (!data || typeof data !== "object") return data;
  delete data.starting_grid;
  delete data.starting_grid_derived;
  delete data.starting_grid_source_session_key;
  if (data.mapped && typeof data.mapped === "object" && Array.isArray(data.mapped.competitors)) {
    data.mapped.competitors = data.mapped.competitors.map((competitor) => {
      if (!competitor || typeof competitor !== "object") return competitor;
      const { grid, laps_led, ...withoutRemovedFields } = competitor;
      return withoutRemovedFields;
    });
  }
  return data;
}

function normaliseSessionData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (!Array.isArray(data.intervals) && Array.isArray(data.intervals_race)) data.intervals = data.intervals_race;
  for (const field of sessionArrayFields) if (!Array.isArray(data[field])) data[field] = [];
  if (Array.isArray(data.sync_warnings)) {
    data.sync_warnings = data.sync_warnings.filter((warning) => !String(warning).startsWith("starting_grid:"));
    if (!data.sync_warnings.length) delete data.sync_warnings;
  }
  return completeSessionResultRows(stripStartingGridFields(stripTyreAgeFields(data)));
}

function sessionCacheHealthy(data, sessionKey) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (Number(data.session?.session_key) !== Number(sessionKey)) return false;
  if (sessionArrayFields.some((field) => !Array.isArray(data[field]))) return false;
  for (const field of sessionArrayFields) {
    if (data[field].some((row) => row?.session_key != null && Number(row.session_key) !== Number(sessionKey))) return false;
  }
  const sessionEnded = Date.parse(data.session?.date_end || "") < Date.now();
  if (sessionEnded && !data.session?.is_cancelled && data.session_result.length > 0 && data.laps.length === 0) return false;
  if (sessionEnded && data.laps.length > 0 && data.session_result.length === 0) return false;
  return true;
}

async function refreshCachedFeed(data, sessionKey, field) {
  const sessionEnded = Date.parse(data.session?.date_end || "") < Date.now();
  const hasRetryWarning = Array.isArray(data.sync_warnings)
    && data.sync_warnings.some((warning) => String(warning).startsWith(`${field}:`) && !String(warning).includes("unavailable"));
  if (!sessionEnded || !Array.isArray(data[field]) || (data[field].length && !hasRetryWarning)) return false;
  const key = Number(sessionKey);
  const probeKey = `${field}:${key}`;
  const now = Date.now();
  if (now - (feedProbeAt.get(probeKey) || 0) < feedProbeIntervalMs) return false;
  feedProbeAt.set(probeKey, now);
  try {
    const rows = await fetchOpenF1(`/${field}?session_key=${encodeURIComponent(key)}`);
    if (!Array.isArray(rows)) return false;
    data[field] = collectSessionFeedRows(field, rows);
    if (Array.isArray(data.sync_warnings)) {
      data.sync_warnings = data.sync_warnings.filter((warning) => !String(warning).startsWith(`${field}:`));
      if (!data.sync_warnings.length) delete data.sync_warnings;
    }
    data.synced_at = new Date().toISOString();
    return true;
  } catch {
    return false;
  }
}

function retryWarningFields(data) {
  return [...new Set((Array.isArray(data?.sync_warnings) ? data.sync_warnings : [])
    .filter((warning) => !String(warning).includes("unavailable"))
    .map((warning) => String(warning).split(":")[0]))]
    .filter((field) => sessionFeedDefinitions.some(([name]) => name === field));
}

const sessionFeedDefinitions = [
  ["drivers", (sessionKey) => `/drivers?session_key=${sessionKey}`],
  ["session_result", (sessionKey) => `/session_result?session_key=${sessionKey}`],
  ["laps", (sessionKey) => `/laps?session_key=${sessionKey}`],
  ["pit", (sessionKey) => `/pit?session_key=${sessionKey}`],
  ["position", (sessionKey) => `/position?session_key=${sessionKey}`],
  ["intervals", (sessionKey) => `/intervals?session_key=${sessionKey}`],
  ["stints", (sessionKey) => `/stints?session_key=${sessionKey}`],
  ["race_control", (sessionKey) => `/race_control?session_key=${sessionKey}`],
  ["weather", (sessionKey) => `/weather?session_key=${sessionKey}`],
];

async function fetchSessionFeeds(sessionKey, cached, sessionName) {
  const requiredFields = new Set(["drivers", "session_result"]);
  const definitions = sessionFeedDefinitions;
  const values = {};
  const failures = [];
  const unavailable = [];
  const retained = [];
  let cursor = 0;
  async function worker() {
    while (cursor < definitions.length) {
      const index = cursor;
      cursor += 1;
      const [key, endpointFactory] = definitions[index];
      try {
        values[key] = collectSessionFeedRows(key, await fetchOpenF1(endpointFactory(sessionKey)));
      } catch (error) {
        if (error.status === 404) { values[key] = []; unavailable.push(key); }
        else if (Array.isArray(cached?.[key])) { values[key] = collectSessionFeedRows(key, cached[key]); retained.push(`${key}: ${error.message}`); }
        else if (requiredFields.has(key)) failures.push(`${key}: ${error.message}`);
        else { values[key] = []; retained.push(`${key}: ${error.message}`); }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, definitions.length) }, () => worker()));
  completeSessionResultRows(values);
  return { values, failures, unavailable, retained };
}

async function sessionData(meetingKey, sessionKey, { force = false, source = "openf1" } = {}) {
  if (normaliseDataSource(source) === "fastf1") return fastF1SessionData(meetingKey, sessionKey, { force });
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedSessionKey)) throw new Error("该节点尚未获得数据源会话键，请在接口可用时重新加载分站目录");
  const cacheFile = path.join(cacheDir, `session_${requestedSessionKey}.json`);
  let previousCache = null;
  if (!renderNoSessionCache && await exists(cacheFile)) {
    try { previousCache = await readJson(cacheFile); } catch { previousCache = null; }
  }
  if (!renderNoSessionCache && !force && await exists(cacheFile)) {
    const data = normaliseSessionData(previousCache);
    if (sessionCacheHealthy(data, requestedSessionKey)) {
      await refreshCachedFeed(data, requestedSessionKey, "weather");
      // Old caches may contain the former FastF1 pit fallback. OpenF1 mode is
      // source-isolated, so discard that foreign feed before refreshing it.
      if (data.pit_source === "fastf1") {
        data.pit = [];
        delete data.pit_source;
      }
      await refreshCachedFeed(data, requestedSessionKey, "pit");
      await refreshCachedFeed(data, requestedSessionKey, "race_control");
      for (const field of retryWarningFields(data)) await refreshCachedFeed(data, requestedSessionKey, field);
      await mergeDriverRoster(meetingKey, data);
      data.mapped = mapOpenF1ToBackend(data, data.mapped);
      data.data_source = "openf1";
      data.cache_version = "20260902-independent-sources-v1";
      if (Array.isArray(data.sync_warnings) && !data.sync_warnings.length) delete data.sync_warnings;
      await writeJsonAtomic(cacheFile, data);
      return { data, source: "cache" };
    }
  }
  if (!renderNoSessionCache && !force) {
    const local = await localSessionData(meetingKey, sessionKey);
    if (local) {
      const data = normaliseSessionData(await mergeDriverRoster(meetingKey, local));
      data.mapped = mapOpenF1ToBackend(data, data.mapped);
      data.cache_version = "20260902-independent-sources-v1";
      await writeJsonAtomic(cacheFile, data);
      return { data, source: "local" };
    }
  }
  const sessionResult = await sessions(meetingKey);
  let sessionList = sessionResult.data || [];
  let session = sessionList.find((row) => Number(row.session_key) === requestedSessionKey);
  // A stale catalog should never prevent a numeric session key from being loaded.
  if (!session) {
    try {
      sessionList = await fetchOpenF1(`/sessions?meeting_key=${encodeURIComponent(meetingKey)}`);
      session = sessionList.find((row) => Number(row.session_key) === requestedSessionKey);
    } catch { /* the error below gives the user an actionable message */ }
  }
  if (!session) throw new Error("找不到对应数据源会话");
  let mapped = Number(previousCache?.session?.session_key) === requestedSessionKey ? previousCache?.mapped || null : null;
  if (!renderNoSessionCache && !mapped && Number(meetingKey) === 1292 && requestedSessionKey === 11353 && await exists(localMapped)) {
    try { mapped = await readJson(localMapped); } catch { mapped = null; }
  }
  const data = { meeting: { meeting_key: Number(meetingKey), country_name: session.country_name, location: session.location, meeting_name: session.meeting_name || session.country_name }, session, mapped };
  const feeds = await fetchSessionFeeds(requestedSessionKey, previousCache, session.session_name);
  Object.assign(data, feeds.values);
  if (feeds.failures.length) throw new Error(`同步失败，缓存未更新（${feeds.failures.join("；")}）`);
  normaliseSessionData(data);
  await mergeDriverRoster(meetingKey, data);
  data.mapped = mapOpenF1ToBackend(data, data.mapped);
  if (!sessionCacheHealthy(data, requestedSessionKey)) throw new Error("同步返回的数据不完整，缓存未更新");
  const syncWarnings = [...feeds.unavailable.map((field) => `${field}: unavailable`), ...feeds.retained];
  if (syncWarnings.length) data.sync_warnings = syncWarnings;
  data.data_source = "openf1";
  data.cache_version = "20260902-independent-sources-v1";
  data.synced_at = new Date().toISOString();
  if (!renderNoSessionCache) await writeJsonAtomic(cacheFile, data);
  return { data, source: "openf1", cache: !renderNoSessionCache };
}

async function liveSessionData(meetingKey, sessionKey) {
  const requestedMeetingKey = Number(meetingKey);
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedMeetingKey) || !Number.isInteger(requestedSessionKey)) {
    throw new Error("请选择有效的分站和节点");
  }
  const data = await fetchF1TelemetryState({ requestedMeetingKey, requestedSessionKey, timeoutMs: upstreamTimeoutMs });
  normaliseSessionData(data);
  data.mapped = mapOpenF1ToBackend(data, data.mapped);
  return { data, source: "f1telemetry-live", live: true };
}

async function serveStatic(req, res, pathname) {
  if (pathname === "/" && !authenticated(req)) {
    res.writeHead(302, { location: "/login" }); res.end(); return;
  }
  if (pathname === "/site/index.html" && !authenticated(req)) {
    res.writeHead(302, { location: "/login" }); res.end(); return;
  }
  const requested = pathname === "/" ? "/site/index.html" : pathname === "/login" ? "/site/login.html" : pathname;
  const candidates = requested.startsWith("/site/")
    ? [requested, requested.replace(/^\/site/, "")]
    : [requested, `/site${requested}`];
  for (const relative of candidates) {
    const candidate = path.resolve(root, `.${relative}`);
    if (!candidate.startsWith(root)) return json(res, 403, { error: "forbidden" });
    try {
      const body = await fs.readFile(candidate);
      const ext = path.extname(candidate);
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" }[ext] || "application/octet-stream";
      res.writeHead(200, { "content-type": type }); res.end(body); return;
    } catch { /* try the root or site fallback */ }
  }
  json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if ((url.pathname === "/health" || url.pathname === "/api/health") && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        service: "f1-live-bridge",
        sources: ["nana", "dash"],
        checked_at: new Date().toISOString(),
      });
    }
    if (url.pathname === "/api/me" && req.method === "GET") return json(res, 200, { authenticated: authenticated(req), username: authenticated(req) ? authUsername : null });
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      if (body.username !== authUsername || !passwordMatches(body.password)) return json(res, 401, { error: "账户名或密码不正确" });
      const token = crypto.randomBytes(32).toString("hex");
      authSessions.set(token, Date.now() + sessionMaxAgeMs);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": authCookie(token) }); res.end(JSON.stringify({ authenticated: true, username: authUsername })); return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req).f1_session;
      if (token) authSessions.delete(token);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": authCookie("", 0) }); res.end(JSON.stringify({ authenticated: false })); return;
    }
    const liveBridge = liveBridgeForPath(url.pathname);
    if (liveBridge && url.pathname.endsWith("/entry") && req.method === "GET") {
      if (!authenticated(req)) return json(res, 401, { error: "需要登录后获取实时入口" });
      return json(res, 200, liveBridgeEntry(req, liveBridge));
    }
    if ((url.pathname === "/api/live-timing/mapping" || url.pathname === "/api/livetiming/mapping") && ["GET", "PUT", "PATCH"].includes(req.method)) {
      if (!authenticated(req)) return json(res, 401, { error: "需要登录后修改车号映射" });
      if (req.method === "GET") return json(res, 200, { ...nanaMapping, source: "official-standings-2026" });
      try {
        const body = await readBody(req);
        nanaMapping = normaliseNanaMapping(body?.mapping || body);
        await writeJsonAtomic(nanaMappingFile, nanaMapping);
        for (const bridge of Object.values(liveBridges)) {
          if (!bridge.state) continue;
          bridge.state = canonicalBackendSnapshot(normaliseNanaSnapshot(bridge.state, nanaMapping));
          broadcastLiveBridgeState(bridge);
        }
        return json(res, 200, { ok: true, ...nanaMapping, source: "official-standings-2026" });
      } catch (error) {
        return json(res, 400, { error: error.message || "车号映射保存失败" });
      }
    }
    if (liveBridge && !liveBridgeAuthorised(req, url, liveBridge)) {
      return json(res, 401, { error: "实时入口令牌无效或已缺少" });
    }
    if (liveBridge && url.pathname.endsWith("/raw") && req.method === "GET") {
      try {
        const raw = await fs.readFile(liveBridge.rawFile, "utf8");
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "content-length": Buffer.byteLength(raw),
        });
        return res.end(raw);
      } catch (error) {
        if (error.code === "ENOENT") return json(res, 404, { error: `尚未缓存 ${liveBridge.name} 原始数据` });
        return json(res, 500, { error: `读取 ${liveBridge.name} 原始数据失败` });
      }
    }
    if (liveBridge && url.pathname.endsWith("/ingest") && req.method === "POST") {
      return ingestLiveBridgeState(req, res, liveBridge);
    }
    if (liveBridge && url.pathname.endsWith("/stream") && req.method === "GET") {
      return openLiveBridgeStream(req, res, liveBridge);
    }
    if (liveBridge && req.method === "GET") {
      return json(res, 200, { data: liveBridgePayload(liveBridge), source_name: liveBridge.name, source: "external-live-timing", live: Boolean(liveBridge.state), sequence: liveBridge.sequence });
    }
    if (url.pathname.startsWith("/api/") && !authenticated(req)) return json(res, 401, { error: "需要登录" });
    if (url.pathname === "/api/seasons") return json(res, 200, await seasons(url.searchParams.get("source")));
    if (url.pathname === "/api/meetings") return json(res, 200, await meetings(url.searchParams.get("year") || "2026", url.searchParams.get("source")));
    if (url.pathname === "/api/sessions") return json(res, 200, await sessions(url.searchParams.get("meeting_key"), url.searchParams.get("source")));
    if (url.pathname === "/api/standings" && req.method === "GET") return json(res, 200, await officialStandings(url.searchParams.get("year")));
    if (url.pathname === "/api/sync-standings" && req.method === "POST") return json(res, 200, await syncOfficialStandings());
    if (url.pathname === "/api/live-session-data" && req.method === "GET") return json(res, 200, await liveSessionData(url.searchParams.get("meeting_key"), url.searchParams.get("session_key")));
    if (url.pathname === "/api/session-data") return json(res, 200, await sessionData(url.searchParams.get("meeting_key"), url.searchParams.get("session_key"), { source: url.searchParams.get("source") }));
    if (url.pathname === "/api/sync-session-data" && req.method === "POST") {
      const body = await readBody(req);
      const source = normaliseDataSource(body.source);
      const syncKey = `${source}:${Number(body.meeting_key)}:${Number(body.session_key)}`;
      let task = sessionSyncInFlight.get(syncKey);
      if (!task) {
        task = sessionData(body.meeting_key, body.session_key, { force: true, source });
        sessionSyncInFlight.set(syncKey, task);
        task.finally(() => {
          if (sessionSyncInFlight.get(syncKey) === task) sessionSyncInFlight.delete(syncKey);
        }).catch(() => {});
      }
      return json(res, 200, await task);
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) { return json(res, 500, { error: error.message || "server error" }); }
});

server.listen(port, host, () => console.log(`F1 data site running at http://${host}:${port}/`));
