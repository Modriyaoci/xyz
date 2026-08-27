import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.F1_PORT || 4173);
const apiBase = "https://api.openf1.org/v1";
const cacheDir = path.join(root, "work", "openf1_cache");
const localDutchDir = path.join(root, "work", "openf1_netherlands_2026");
const localMapped = path.join(root, "outputs", "openf1-mapped-result", "netherlands_2026_race_openf1_mapped.json");
const officialStandingsFile = path.join(root, "official-standings-2026.json");
const execFileAsync = promisify(execFile);
const authUsername = "nana";
const authSalt = "f1-openf1-local-auth";
const authPasswordHash = crypto.scryptSync("123456", authSalt, 32);
const authSessions = new Map();
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const feedProbeAt = new Map();
const feedProbeIntervalMs = 5 * 60 * 1000;

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

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const exists = async (file) => fs.access(file).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(`${apiBase}${endpoint}`, { headers: { accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Math.max(1000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0) * (attempt + 1));
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
  const catalogFile = path.join(cacheDir, `catalog_${year}.json`);
  let localFallback = null;
  if (Number(year) === 2026 && (await exists(localFile) || await exists(catalogFile))) {
    try {
      const source = await exists(localFile) ? await readJson(localFile) : await readJson(catalogFile);
      const rows = Array.isArray(source) ? source : source.meetings;
      localFallback = Array.isArray(rows) ? rows.map(normaliseMeeting) : null;
    } catch { localFallback = null; }
  }
  const result = await cachedJson(localFile, `/meetings?year=${encodeURIComponent(year)}`, localFallback);
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
  if (result.source === "local") result.source = "catalog";
  return result;
}

async function sessions(meetingKey) {
  const key = Number(meetingKey);
  const cacheFile = path.join(cacheDir, `sessions_${key}.json`);
  if (await exists(cacheFile)) {
    const cached = await readJson(cacheFile);
    return { data: Array.isArray(cached) ? cached : [], source: "cache" };
  }
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

async function officialStandings() {
  if (!(await exists(officialStandingsFile))) throw new Error("年度排名快照尚未生成");
  const data = await readJson(officialStandingsFile);
  if (!Array.isArray(data.drivers) || !Array.isArray(data.teams)) throw new Error("年度排名快照格式不完整");
  return { data, source: "local" };
}

async function syncOfficialStandings() {
  try {
    await execFileAsync(process.execPath, [path.join(root, "scripts", "sync-official-standings.mjs"), "2026"], { cwd: root, timeout: 120000 });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || "官网快照同步失败";
    throw new Error(`年度排名同步失败：${detail}`);
  }
  return officialStandings();
}

async function localSessionData(meetingKey, sessionKey) {
  if (Number(meetingKey) !== 1292) return null;
  const files = ["drivers.json", "session_result.json", "starting_grid.json", "laps.json", "pit.json", "position.json", "intervals_race.json", "stints.json", "race_control.json", "weather.json"];
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

const sessionArrayFields = ["drivers", "session_result", "starting_grid", "laps", "pit", "position", "intervals", "stints", "race_control", "weather"];

function stripTyreAgeFields(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.stints)) return data;
  data.stints = data.stints.map((stint) => {
    const { tyre_age_at_start, tyre_age, tire_age_at_start, tire_age, ...withoutAge } = stint || {};
    return withoutAge;
  });
  return data;
}

function normaliseSessionData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (!Array.isArray(data.intervals) && Array.isArray(data.intervals_race)) data.intervals = data.intervals_race;
  for (const field of sessionArrayFields) if (!Array.isArray(data[field])) data[field] = [];
  return stripTyreAgeFields(data);
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
  if (!sessionEnded || !Array.isArray(data[field]) || data[field].length) return false;
  const key = Number(sessionKey);
  const probeKey = `${field}:${key}`;
  const now = Date.now();
  if (now - (feedProbeAt.get(probeKey) || 0) < feedProbeIntervalMs) return false;
  feedProbeAt.set(probeKey, now);
  try {
    const rows = await fetchOpenF1(`/${field}?session_key=${encodeURIComponent(key)}`);
    if (!Array.isArray(rows) || !rows.length) return false;
    data[field] = rows;
    if (Array.isArray(data.sync_warnings)) {
      data.sync_warnings = data.sync_warnings.filter((warning) => !String(warning).startsWith(`${field}:`));
      if (!data.sync_warnings.length) delete data.sync_warnings;
    }
    return true;
  } catch {
    return false;
  }
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
      await mergeDriverRoster(meetingKey, data);
      await writeJsonAtomic(cacheFile, data);
      return { data, source: "cache" };
    }
  }
  if (!force) {
    const local = await localSessionData(meetingKey, sessionKey);
    if (local) {
      const data = normaliseSessionData(await mergeDriverRoster(meetingKey, local));
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
  const endpoints = [
    ["drivers", `/drivers?session_key=${requestedSessionKey}`], ["session_result", `/session_result?session_key=${requestedSessionKey}`], ["starting_grid", `/starting_grid?session_key=${requestedSessionKey}`],
    ["laps", `/laps?session_key=${requestedSessionKey}`], ["pit", `/pit?session_key=${requestedSessionKey}`], ["position", `/position?session_key=${requestedSessionKey}`], ["intervals", `/intervals?session_key=${requestedSessionKey}`],
    ["stints", `/stints?session_key=${requestedSessionKey}`], ["race_control", `/race_control?session_key=${requestedSessionKey}`], ["weather", `/weather?session_key=${requestedSessionKey}`],
  ];
  let mapped = Number(previousCache?.session?.session_key) === requestedSessionKey ? previousCache?.mapped || null : null;
  if (!mapped && Number(meetingKey) === 1292 && requestedSessionKey === 11353 && await exists(localMapped)) {
    try { mapped = await readJson(localMapped); } catch { mapped = null; }
  }
  const data = { meeting: { meeting_key: Number(meetingKey), country_name: session.country_name, location: session.location, meeting_name: session.meeting_name || session.country_name }, session, mapped };
  const failures = [];
  const unavailable = [];
  const retained = [];
  const requiredFields = new Set(["drivers", "session_result"]);
  for (const [key, endpoint] of endpoints) {
    await sleep(360);
    try { data[key] = await fetchOpenF1(endpoint); }
    catch (error) {
      // Some sessions legitimately have no starting grid or interval feed.
      // Keep a previous field when a transient error affects only one feed.
      if (error.status === 404) { data[key] = []; unavailable.push(key); }
      else if (Array.isArray(previousCache?.[key])) {
        data[key] = previousCache[key];
        retained.push(`${key}: ${error.message}`);
      } else if (requiredFields.has(key)) failures.push(`${key}: ${error.message}`);
      else { data[key] = []; retained.push(`${key}: ${error.message}`); }
    }
  }
  if (failures.length) throw new Error(`同步失败，缓存未更新（${failures.join("；")}）`);
  normaliseSessionData(data);
  await mergeDriverRoster(meetingKey, data);
  if (!sessionCacheHealthy(data, requestedSessionKey)) throw new Error("同步返回的数据不完整，缓存未更新");
  const syncWarnings = [...unavailable.map((field) => `${field}: unavailable`), ...retained];
  if (syncWarnings.length) data.sync_warnings = syncWarnings;
  await writeJsonAtomic(cacheFile, data);
  return { data, source: "openf1" };
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
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" }[ext] || "application/octet-stream";
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
    if (url.pathname.startsWith("/api/") && !authenticated(req)) return json(res, 401, { error: "需要登录" });
    if (url.pathname === "/api/meetings") return json(res, 200, await meetings(url.searchParams.get("year") || "2026"));
    if (url.pathname === "/api/sessions") return json(res, 200, await sessions(url.searchParams.get("meeting_key")));
    if (url.pathname === "/api/standings" && req.method === "GET") return json(res, 200, await officialStandings());
    if (url.pathname === "/api/sync-standings" && req.method === "POST") return json(res, 200, await syncOfficialStandings());
    if (url.pathname === "/api/session-data") return json(res, 200, await sessionData(url.searchParams.get("meeting_key"), url.searchParams.get("session_key")));
    if (url.pathname === "/api/sync-session-data" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await sessionData(body.meeting_key, body.session_key, { force: true }));
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) { return json(res, 500, { error: error.message || "server error" }); }
});

server.listen(port, "127.0.0.1", () => console.log(`F1 data site running at http://127.0.0.1:${port}/`));
