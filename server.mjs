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

const root = path.dirname(fileURLToPath(import.meta.url));
// Cloud hosts provide PORT; keep F1_PORT for local and existing deployments.
const port = Number(process.env.PORT || process.env.F1_PORT || 4173);
const host = String(process.env.F1_HOST || "127.0.0.1");
const apiBase = "https://api.openf1.org/v1";
const upstreamTimeoutMs = 30000;
const upstreamRequestIntervalMs = 400;
let nextUpstreamRequestAt = 0;
const cacheDir = path.join(root, "work", "openf1_cache");
const meetingCatalogFile = path.join(root, "meetings-all.json");
const localDutchDir = path.join(root, "work", "openf1_netherlands_2026");
const localMapped = path.join(root, "outputs", "openf1-mapped-result", "netherlands_2026_race_openf1_mapped.json");
const currentStandingsSeason = 2026;
const standingsSeasons = new Set([2023, 2024, 2025, currentStandingsSeason]);
const standingsSeason = (value) => standingsSeasons.has(Number(value)) ? Number(value) : currentStandingsSeason;
const officialStandingsFile = (year = currentStandingsSeason) => path.join(root, `official-standings-${standingsSeason(year)}.json`);
const execFileAsync = promisify(execFile);
const authUsername = String(process.env.F1_AUTH_USERNAME || "nana");
const authSalt = "f1-openf1-local-auth";
const authPassword = String(process.env.F1_AUTH_PASSWORD || "123456");
const authPasswordHash = crypto.scryptSync(authPassword, authSalt, 32);
const authSessions = new Map();
const sessionSyncInFlight = new Map();
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const feedProbeAt = new Map();
const feedProbeIntervalMs = 5 * 60 * 1000;
const liveBridgeToken = String(process.env.LIVE_TIMING_BRIDGE_TOKEN || crypto.createHash("sha256").update(authPasswordHash).digest("hex"));
let liveBridgeState = null;
let liveBridgeSequence = 0;
const liveBridgeClients = new Set();

await fs.mkdir(cacheDir, { recursive: true });

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

const liveBridgePaths = new Set([
  "/api/live-timing",
  "/api/live-timing/entry",
  "/api/live-timing/ingest",
  "/api/live-timing/stream",
  "/api/livetiming",
  "/api/livetiming/entry",
  "/api/livetiming/ingest",
  "/api/livetiming/stream",
]);

function liveBridgeTokenFromRequest(req, url) {
  const header = req.headers["x-live-timing-token"] || req.headers["x-livetiming-token"];
  const authorization = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return String(header || authorization || url.searchParams.get("token") || "");
}

function liveBridgeAuthorised(req, url) {
  return authenticated(req) || liveBridgeTokenFromRequest(req, url) === liveBridgeToken;
}

function liveBridgeBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  return `${protocol}://${req.headers.host || "127.0.0.1:4174"}`;
}

function writeLiveBridgeEvent(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function broadcastLiveBridgeState() {
  if (!liveBridgeState) return;
  for (const client of liveBridgeClients) {
    try {
      writeLiveBridgeEvent(client.res, "state", liveBridgeState);
    } catch {
      clearInterval(client.heartbeat);
      liveBridgeClients.delete(client);
    }
  }
}

function openLiveBridgeStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, must-revalidate",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  res.write(": live-timing bridge connected\n\n");
  const client = {
    res,
    heartbeat: setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* close handler removes the client */ }
    }, 15000),
  };
  liveBridgeClients.add(client);
  if (liveBridgeState) writeLiveBridgeEvent(res, "state", liveBridgeState);
  req.on("close", () => {
    clearInterval(client.heartbeat);
    liveBridgeClients.delete(client);
  });
}

async function ingestLiveBridgeState(req, res) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024 * 1024) return json(res, 413, { error: "实时快照超过 8 MB 限制" });
  const body = await readBody(req);
  const incoming = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return json(res, 400, { error: "请求体必须是实时快照 JSON" });
  if (!incoming.session && !incoming.meeting && !incoming.mapped) return json(res, 400, { error: "实时快照至少需要 session、meeting 或 mapped 字段" });
  const receivedAt = new Date().toISOString();
  const data = { ...incoming, live: true, fetched_at: incoming.fetched_at || receivedAt };
  normaliseSessionData(data);
  data.mapped = mapOpenF1ToBackend(data, data.mapped);
  liveBridgeSequence += 1;
  liveBridgeState = {
    ...data,
    source_name: "nana",
    data_source: "external-live-timing",
    source_session: "external-live-timing",
    live_bridge: { sequence: liveBridgeSequence, received_at: receivedAt, source: "external-live-timing" },
  };
  broadcastLiveBridgeState();
  return json(res, 200, { ok: true, source_name: "nana", source: "external-live-timing", sequence: liveBridgeSequence, received_at: receivedAt });
}

function liveBridgeEntry(req) {
  const base = liveBridgeBaseUrl(req);
  const token = encodeURIComponent(liveBridgeToken);
  return {
    ok: true,
    source_name: "nana",
    source: "external-live-timing",
    memory_only: true,
    ingest: { method: "POST", url: `${base}/api/live-timing/ingest?token=${token}`, header: "X-Live-Timing-Token" },
    state: { method: "GET", url: `${base}/api/live-timing?token=${token}` },
    stream: { method: "GET", url: `${base}/api/live-timing/stream?token=${token}`, content_type: "text/event-stream" },
    sequence: liveBridgeSequence,
    received_at: liveBridgeState?.live_bridge?.received_at || null,
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

async function seasons() {
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

async function meetings(year) {
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

async function sessions(meetingKey) {
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

async function sessionData(meetingKey, sessionKey, { force = false } = {}) {
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedSessionKey)) throw new Error("该节点尚未获得数据源会话键，请在接口可用时重新加载分站目录");
  const cacheFile = path.join(cacheDir, `session_${requestedSessionKey}.json`);
  let previousCache = null;
  if (await exists(cacheFile)) {
    try { previousCache = await readJson(cacheFile); } catch { previousCache = null; }
  }
  if (!force && await exists(cacheFile)) {
    const data = normaliseSessionData(previousCache);
    if (sessionCacheHealthy(data, requestedSessionKey)) {
      await refreshCachedFeed(data, requestedSessionKey, "weather");
      if (["Race", "Sprint"].includes(data.session?.session_name)) await refreshCachedFeed(data, requestedSessionKey, "pit");
      await refreshCachedFeed(data, requestedSessionKey, "race_control");
      for (const field of retryWarningFields(data)) await refreshCachedFeed(data, requestedSessionKey, field);
      await mergeDriverRoster(meetingKey, data);
      data.mapped = mapOpenF1ToBackend(data, data.mapped);
      data.cache_version = "20260828-backend-fields-v5";
      await writeJsonAtomic(cacheFile, data);
      return { data, source: "cache" };
    }
  }
  if (!force) {
    const local = await localSessionData(meetingKey, sessionKey);
    if (local) {
      const data = normaliseSessionData(await mergeDriverRoster(meetingKey, local));
      data.mapped = mapOpenF1ToBackend(data, data.mapped);
      data.cache_version = "20260828-backend-fields-v5";
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
  if (!mapped && Number(meetingKey) === 1292 && requestedSessionKey === 11353 && await exists(localMapped)) {
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
  data.cache_version = "20260828-backend-fields-v5";
  data.synced_at = new Date().toISOString();
  await writeJsonAtomic(cacheFile, data);
  return { data, source: "openf1" };
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
    if ((url.pathname === "/api/live-timing/entry" || url.pathname === "/api/livetiming/entry") && req.method === "GET") {
      if (!authenticated(req)) return json(res, 401, { error: "需要登录后获取实时入口" });
      return json(res, 200, liveBridgeEntry(req));
    }
    if (liveBridgePaths.has(url.pathname) && !liveBridgeAuthorised(req, url)) return json(res, 401, { error: "实时入口令牌无效或已缺少" });
    if ((url.pathname === "/api/live-timing/ingest" || url.pathname === "/api/livetiming/ingest") && req.method === "POST") return ingestLiveBridgeState(req, res);
    if ((url.pathname === "/api/live-timing/stream" || url.pathname === "/api/livetiming/stream") && req.method === "GET") return openLiveBridgeStream(req, res);
    if ((url.pathname === "/api/live-timing" || url.pathname === "/api/livetiming") && req.method === "GET") {
      return json(res, 200, { data: liveBridgeState, source_name: "nana", source: "external-live-timing", live: Boolean(liveBridgeState), sequence: liveBridgeSequence });
    }
    if (url.pathname.startsWith("/api/") && !authenticated(req)) return json(res, 401, { error: "需要登录" });
    if (url.pathname === "/api/seasons") return json(res, 200, await seasons());
    if (url.pathname === "/api/meetings") return json(res, 200, await meetings(url.searchParams.get("year") || "2026"));
    if (url.pathname === "/api/sessions") return json(res, 200, await sessions(url.searchParams.get("meeting_key")));
    if (url.pathname === "/api/standings" && req.method === "GET") return json(res, 200, await officialStandings(url.searchParams.get("year")));
    if (url.pathname === "/api/sync-standings" && req.method === "POST") return json(res, 200, await syncOfficialStandings());
    if (url.pathname === "/api/live-session-data" && req.method === "GET") return json(res, 200, await liveSessionData(url.searchParams.get("meeting_key"), url.searchParams.get("session_key")));
    if (url.pathname === "/api/session-data") return json(res, 200, await sessionData(url.searchParams.get("meeting_key"), url.searchParams.get("session_key")));
    if (url.pathname === "/api/sync-session-data" && req.method === "POST") {
      const body = await readBody(req);
      const syncKey = `${Number(body.meeting_key)}:${Number(body.session_key)}`;
      let task = sessionSyncInFlight.get(syncKey);
      if (!task) {
        task = sessionData(body.meeting_key, body.session_key, { force: true });
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
