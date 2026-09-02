import {
  mapOpenF1ToBackend,
  resolveBackendDriverId as sharedResolveBackendDriverId,
  resolveBackendTeamId as sharedResolveBackendTeamId,
} from "./backend-fields.mjs";
import { openF1TelemetryStream } from "./f1telemetry.mjs";
import { collectSessionFeedRows, completeSessionResultRows, isCompleteLapRecord } from "./session-feed-rules.mjs";

const state = {
  season: 2026,
  seasons: [],
  meetings: [],
  sessions: [],
  activeMeeting: null,
  activeSession: null,
  activePhase: null,
  data: null,
  standings: null,
  standingsError: null,
  standingsKind: "drivers",
  standingsSeason: 2026,
  resultColumnVisibility: null,
  activeView: "schedule",
  selectedDriver: null,
  search: "",
  weatherView: "all",
  messageView: "all",
  messageLanguage: "both",
  dataRequestId: 0,
  liveTiming: {
    source: "f1telemetry",
    meetingKey: null,
    sessionKey: null,
    meetingName: "",
    sessionName: "",
    sessions: [],
    data: null,
    rows: [],
    events: [],
    logs: [],
    received: 0,
    errors: 0,
    selectedDriver: null,
    search: "",
    weatherView: "all",
    messageView: "all",
    messageLanguage: "both",
    running: false,
    started: false,
    timer: null,
    token: 0,
    lastAt: null,
    loading: false,
    sequence: 0,
    stream: null,
  },
};

// GitHub Pages cannot run the Node proxy. In that deployment the browser talks
// to OpenF1 directly and keeps complete session snapshots in IndexedDB.
const localServer = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const githubPages = window.location.hostname.endsWith(".github.io");
const STATIC_MODE = new URLSearchParams(window.location.search).get("static") === "1"
  || githubPages;
const STATIC_API_BASE = "https://api.openf1.org/v1";
const STATIC_CACHE_VERSION = "20260828-backend-fields-v5";
const staticRequestTimeoutMs = 30000;
const staticRequestIntervalMs = 400;
let staticNextRequestAt = 0;
const STATIC_CATALOG_URL = new URL("./meetings-all.json", import.meta.url).href;
const STATIC_MAPPED_URL = new URL("./netherlands-race-mapped.json", import.meta.url).href;
const staticStandingsUrl = (year) => new URL(
  window.location.pathname.startsWith("/site/") ? `../official-standings-${year}.json` : `./official-standings-${year}.json`,
  import.meta.url,
).href;
const staticDb = { promise: null };
let staticCatalogPromise = null;
const staticSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const staticFeedProbeAt = new Map();
const staticFeedProbeIntervalMs = 5 * 60 * 1000;

function openStaticDb() {
  if (staticDb.promise) return staticDb.promise;
  if (!window.indexedDB) return Promise.resolve(null);
  staticDb.promise = new Promise((resolve) => {
    const request = window.indexedDB.open("f1-openf1-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("responses");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return staticDb.promise;
}

async function staticCacheGet(key) {
  const db = await openStaticDb();
  if (db) {
    const value = await new Promise((resolve) => {
      const request = db.transaction("responses", "readonly").objectStore("responses").get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
    if (value != null) return value;
  }
  try { return JSON.parse(window.localStorage.getItem(`f1-openf1:${key}`) || "null"); } catch { return null; }
}

async function staticCacheSet(key, value) {
  const db = await openStaticDb();
  if (db) {
    await new Promise((resolve) => {
      const request = db.transaction("responses", "readwrite").objectStore("responses").put(value, key);
      request.onsuccess = request.onerror = () => resolve();
    });
    return;
  }
  try { window.localStorage.setItem(`f1-openf1:${key}`, JSON.stringify(value)); } catch { /* quota or private mode */ }
}

async function staticFetchJson(endpoint) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    const requestAt = Math.max(now, staticNextRequestAt);
    staticNextRequestAt = requestAt + staticRequestIntervalMs;
    if (requestAt > now) await staticSleep(requestAt - now);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), staticRequestTimeoutMs);
    let response;
    try {
      response = await fetch(`${STATIC_API_BASE}${endpoint}`, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (attempt < 1) { await staticSleep(800); continue; }
      if (error?.name === "AbortError") throw new Error(`数据源请求超时（${staticRequestTimeoutMs / 1000}秒） for ${endpoint}`);
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    if (response.ok) return response.json();
    if ((response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) && attempt < 1) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await staticSleep(Math.min(3000, Math.max(700, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
      continue;
    }
    const error = new Error(`数据源 ${response.status} for ${endpoint}`);
    error.status = response.status;
    throw error;
  }
  throw new Error(`数据源请求失败 for ${endpoint}`);
}

async function refreshStaticCachedFeed(data, sessionKey, field) {
  const sessionEnded = Date.parse(data.session?.date_end || "") < Date.now();
  const hasRetryWarning = Array.isArray(data.sync_warnings)
    && data.sync_warnings.some((warning) => String(warning).startsWith(`${field}:`) && !String(warning).includes("unavailable"));
  if (!sessionEnded || !Array.isArray(data[field]) || (data[field].length && !hasRetryWarning)) return;
  const key = Number(sessionKey);
  const probeKey = `${field}:${key}`;
  const now = Date.now();
  if (now - (staticFeedProbeAt.get(probeKey) || 0) < staticFeedProbeIntervalMs) return;
  staticFeedProbeAt.set(probeKey, now);
  try {
    const rows = await staticFetchJson(`/${field}?session_key=${encodeURIComponent(key)}`);
    if (Array.isArray(rows)) {
      data[field] = collectSessionFeedRows(field, rows);
      if (Array.isArray(data.sync_warnings)) {
        data.sync_warnings = data.sync_warnings.filter((warning) => !String(warning).startsWith(`${field}:`));
        if (!data.sync_warnings.length) delete data.sync_warnings;
      }
      data.synced_at = new Date().toISOString();
    }
  } catch { /* retain the existing cache when the data source is unavailable */ }
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

async function fetchStaticSessionFeeds(sessionKey, cached, sessionName) {
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
        values[key] = collectSessionFeedRows(key, await staticFetchJson(endpointFactory(sessionKey)));
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

async function staticCatalogPayload() {
  if (!staticCatalogPromise) {
    staticCatalogPromise = fetch(STATIC_CATALOG_URL, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`赛季目录读取失败 ${response.status}`);
      return response.json();
    });
  }
  return staticCatalogPromise;
}

async function staticSeasons() {
  const payload = await staticCatalogPayload();
  const rows = Array.isArray(payload) ? payload : payload.meetings;
  const listed = Array.isArray(payload?.seasons) ? payload.seasons : (Array.isArray(rows) ? rows.map((meeting) => meeting.year) : []);
  return [...new Set(listed.map(Number).filter(Number.isInteger))].sort((a, b) => b - a);
}

async function staticCatalog(year = state.season) {
  const payload = await staticCatalogPayload();
  const rows = Array.isArray(payload) ? payload : payload.meetings;
  return (Array.isArray(rows) ? rows : []).filter((meeting) => Number(meeting.year) === Number(year)).map((meeting) => ({
    ...meeting,
    meeting_key: Number(meeting.meeting_key),
    sessions: Array.isArray(meeting.sessions) ? meeting.sessions : [],
  }));
}

function stripTyreAgeFields(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.stints)) return data;
  data.stints = data.stints.map((stint) => {
    const { tyre_age_at_start, tyre_age, tire_age_at_start, tire_age, ...withoutAge } = stint || {};
    return withoutAge;
  });
  return data;
}

function stripIgnoredSyncWarnings(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sync_warnings)) return data;
  data.sync_warnings = data.sync_warnings.filter((warning) => !String(warning).startsWith("starting_grid:"));
  if (!data.sync_warnings.length) delete data.sync_warnings;
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

function resolveBackendDriverId(driver) {
  return sharedResolveBackendDriverId(driver);
}

function enrichBackendMapping(data) {
  if (!data || typeof data !== "object") return data;
  data.mapped = mapOpenF1ToBackend(data, data.mapped);
  return data;
}

async function staticSessionList(meetingKey) {
  const key = Number(meetingKey);
  const catalog = await staticCatalog();
  const meeting = catalog.find((item) => Number(item.meeting_key) === key);
  if (!meeting) throw new Error("找不到对应分站");
  if (meeting.sessions.length) return { data: meeting.sessions, source: "catalog" };
  const cacheKey = `${STATIC_CACHE_VERSION}:sessions:${key}`;
  const cached = await staticCacheGet(cacheKey);
  if (Array.isArray(cached) && cached.length) return { data: cached, source: "cache" };
  const data = await staticFetchJson(`/sessions?meeting_key=${encodeURIComponent(key)}`);
  await staticCacheSet(cacheKey, data);
  return { data, source: "openf1" };
}

async function staticSessionSnapshot(meetingKey, sessionKey, { force = false } = {}) {
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedSessionKey)) throw new Error("该节点尚未获得数据源会话键");
  const cacheKey = `${STATIC_CACHE_VERSION}:session:${requestedSessionKey}`;
  const cached = await staticCacheGet(cacheKey);
  if (!force && cached && Number(cached.session?.session_key) === requestedSessionKey) {
    const sanitised = completeSessionResultRows(stripStartingGridFields(stripIgnoredSyncWarnings(stripTyreAgeFields(cached))));
    await refreshStaticCachedFeed(sanitised, requestedSessionKey, "weather");
    if (["Race", "Sprint"].includes(sanitised.session?.session_name)) await refreshStaticCachedFeed(sanitised, requestedSessionKey, "pit");
    await refreshStaticCachedFeed(sanitised, requestedSessionKey, "race_control");
    for (const field of retryWarningFields(sanitised)) await refreshStaticCachedFeed(sanitised, requestedSessionKey, field);
    enrichBackendMapping(sanitised);
    sanitised.cache_version = STATIC_CACHE_VERSION;
    await staticCacheSet(cacheKey, sanitised);
    return { data: sanitised, source: "cache" };
  }
  const sessionsPayload = await staticSessionList(meetingKey);
  const session = (sessionsPayload.data || []).find((item) => Number(item.session_key) === requestedSessionKey);
  if (!session) throw new Error("找不到对应数据源会话");
  const data = { meeting: { meeting_key: Number(meetingKey), country_name: session.country_name, location: session.location, meeting_name: session.meeting_name || session.country_name }, session, mapped: null };
  const feeds = await fetchStaticSessionFeeds(requestedSessionKey, cached, session.session_name);
  Object.assign(data, feeds.values);
  if (feeds.failures.length) throw new Error(`同步失败，缺少必要数据（${feeds.failures.join("；")}）`);
  if (Number(meetingKey) === 1292 && requestedSessionKey === 11353) {
    try {
      const mappedResponse = await fetch(STATIC_MAPPED_URL, { cache: "no-store" });
      if (mappedResponse.ok) data.mapped = await mappedResponse.json();
    } catch { /* the data source remains usable without the optional mapping */ }
  }
  const syncWarnings = [...feeds.unavailable.map((field) => `${field}: unavailable`), ...feeds.retained];
  if (syncWarnings.length) data.sync_warnings = syncWarnings;
  stripIgnoredSyncWarnings(data);
  stripStartingGridFields(data);
  data.cache_version = STATIC_CACHE_VERSION;
  data.synced_at = new Date().toISOString();
  stripTyreAgeFields(data);
  enrichBackendMapping(data);
  data.cache_version = STATIC_CACHE_VERSION;
  await staticCacheSet(cacheKey, data);
  return { data, source: "openf1" };
}

async function staticLiveSessionSnapshot(meetingKey, sessionKey) {
  const requestedMeetingKey = Number(meetingKey);
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedMeetingKey) || !Number.isInteger(requestedSessionKey)) throw new Error("请选择有效的分站和节点");
  const data = await fetchF1TelemetryState({ requestedMeetingKey, requestedSessionKey, timeoutMs: staticRequestTimeoutMs });
  stripStartingGridFields(stripTyreAgeFields(data));
  enrichBackendMapping(data);
  return { data, source: "f1telemetry-live", live: true };
}

function enrichOfficialStandings(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const drivers = (Array.isArray(snapshot.drivers) ? snapshot.drivers : []).map((row) => ({
    ...(() => {
      const { backend_driver_id: _legacyDriverId, backend_team_id: _legacyTeamId, ...rest } = row || {};
      return rest;
    })(),
    _id: row._id ?? row.backend_driver_id ?? resolveBackendDriverId({ name_acronym: row.code, full_name: row.name }),
    teamuid: row.teamuid ?? row.backend_team_id ?? sharedResolveBackendTeamId(row.team),
  }));
  const teams = (Array.isArray(snapshot.teams) ? snapshot.teams : []).map((row) => ({
    ...(() => {
      const { backend_team_id: _legacyTeamId, ...rest } = row || {};
      return rest;
    })(),
    teamuid: row.teamuid ?? row.backend_team_id ?? sharedResolveBackendTeamId(row.name),
  }));
  return { ...snapshot, drivers, teams };
}

async function staticStandings({ force = false } = {}) {
  const year = force ? 2026 : state.standingsSeason;
  const cacheKey = `${STATIC_CACHE_VERSION}:official-standings:${year}`;
  const cached = await staticCacheGet(cacheKey);
  try {
    const response = await fetch(staticStandingsUrl(year), { cache: "no-store" });
    if (!response.ok) throw new Error(`年度排名快照读取失败 ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.drivers) || !Array.isArray(data.teams)) throw new Error("年度排名快照格式不完整");
    await staticCacheSet(cacheKey, data);
    return { data, source: "official" };
  } catch (error) {
    if (cached && Number(cached.season) === Number(year)) return { data: cached, source: "cache", error: error.message };
    throw error;
  }
}

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[char]));
const number = (value, fallback = "--") => value === null || value === undefined || value === "" ? fallback : Number(value).toLocaleString("en-US");
const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const liveDriverProfiles = new Map([
  [347482, { name: "Max Verstappen", code: "VER" }], [347492, { name: "Charles Leclerc", code: "LEC" }],
  [347499, { name: "Pierre Gasly", code: "GAS" }], [347501, { name: "George Russell", code: "RUS" }],
  [347502, { name: "Fernando Alonso", code: "ALO" }], [347503, { name: "Lance Stroll", code: "STR" }],
  [347504, { name: "Alexander Albon", code: "ALB" }], [347506, { name: "Lando Norris", code: "NOR" }],
  [347514, { name: "Liam Lawson", code: "LAW" }], [347519, { name: "Sergio Perez", code: "PER" }],
  [347520, { name: "Oliver Bearman", code: "BEA" }], [347525, { name: "Valtteri Bottas", code: "BOT" }],
  [347528, { name: "Oscar Piastri", code: "PIA" }], [347534, { name: "Kimi Antonelli", code: "ANT" }],
  [347537, { name: "Isack Hadjar", code: "HAD" }], [347539, { name: "Gabriel Bortoleto", code: "BOR" }],
  [347540, { name: "Franco Colapinto", code: "COL" }], [347542, { name: "Lewis Hamilton", code: "HAM" }],
  [347544, { name: "Nico Hulkenberg", code: "HUL" }], [347547, { name: "Esteban Ocon", code: "OCO" }],
  [347548, { name: "Carlos Sainz", code: "SAI" }], [347549, { name: "Arvid Lindblad", code: "LIN" }],
]);
const liveTeamNames = new Map([
  [385355, "Red Bull Racing"], [385358, "Mercedes"], [385361, "Haas F1 Team"],
  [385362, "Aston Martin"], [385363, "Racing Bulls"], [385364, "Ferrari"],
  [385365, "Williams"], [385366, "Alpine"], [385367, "McLaren"],
  [385368, "Kick Sauber"], [390378, "Cadillac"], [394048, "Audi"],
]);
const backendDriverImageIds = new Set([
  347421, 347422, 347423, 347424, 347425, 347426, 347427, 347428, 347429, 347430,
  347431, 347432, 347433, 347434, 347435, 347436, 347437, 347439, 347440, 347441,
  347442, 347443, 347444, 347445, 347446, 347447, 347448, 347449, 347450, 347451,
  347453, 347454, 347455, 347456, 347457, 347458, 347460, 347461, 347462, 347463,
  347464, 347465, 347466, 347467, 347468, 347470, 347473, 347474, 347475, 347476,
  347477, 347478, 347479, 347480, 347481, 347482, 347483, 347484, 347485, 347486,
  347487, 347488, 347489, 347491, 347492, 347493, 347494, 347495, 347496, 347497,
  347498, 347499, 347501, 347502, 347503, 347504, 347506, 347511, 347514, 347517,
  347518, 347519, 347520, 347522, 347525, 347526, 347528, 347531, 347534, 347535,
  347536, 347537, 347538, 347539, 347540, 347541, 347542, 347543, 347544, 347545,
  347546, 347547, 347548, 347549, 347550, 347555, 347556, 347557, 347908, 347909,
  347521, 347524, 347529, 347530, 347532, 350540, 368438, 368439,
]);
const backendTeamImageIds = new Set([
  385355, 385358, 385361, 385362, 385363, 385364, 385365, 385366, 385367,
  385368, 390378, 394048,
]);
const backendIdentityAsset = (kind, id) => new URL(`./assets/f1/${kind}/${Number(id)}.png`, import.meta.url).href;
const backendTeamAsset = (id, name) => {
  const resolvedId = numeric(id);
  if (resolvedId === 385363 && /alpha\s*tauri/i.test(String(name || ""))) {
    return new URL("./assets/f1/teams/385363-alphatauri.png", import.meta.url).href;
  }
  if (resolvedId === 385368 && /alfa\s+romeo/i.test(String(name || ""))) {
    return new URL("./assets/f1/teams/385368-alfa-romeo.png", import.meta.url).href;
  }
  return backendIdentityAsset("teams", resolvedId);
};
const identityInitials = (name) => String(name || "?").trim().split(/\s+/).map((part) => part[0] || "").slice(0, 2).join("").toUpperCase() || "?";
function driverImageHtml(id, name, className = "") {
  const resolvedId = numeric(id);
  if (resolvedId != null && backendDriverImageIds.has(resolvedId)) {
    return `<img class="identity-image driver-identity-image ${className}" src="${esc(backendIdentityAsset("drivers", resolvedId))}" alt="${esc(name || "车手")}" loading="lazy" decoding="async">`;
  }
  return `<span class="identity-image identity-image-fallback driver-identity-image ${className}" aria-label="${esc(name || "车手")}">${esc(identityInitials(name))}</span>`;
}
function teamImageHtml(id, name, className = "") {
  const resolvedId = numeric(id);
  if (resolvedId == null || !backendTeamImageIds.has(resolvedId)) return "";
  return `<img class="identity-image team-identity-image ${className}" src="${esc(backendTeamAsset(resolvedId, name))}" alt="${esc(name || "车队")} Logo" loading="lazy" decoding="async">`;
}
function detailIdentityHtml({ driverId, teamId, name, car, team }) {
  return `<div class="detail-identity"><div class="detail-driver-identity">${driverImageHtml(driverId, name, "detail-driver-image")}<div><strong>${esc(name || "--")}</strong><span>#${esc(car ?? "--")}</span></div></div><div class="detail-team-identity">${teamImageHtml(teamId, team, "detail-team-image")}<span>${esc(team || "--")}</span></div></div>`;
}
const fixed = (value, digits = 3) => numeric(value) == null ? "--" : numeric(value).toFixed(digits);
const dateText = (value) => value
  ? String(value).replace(/(\.\d{3})\d+/, "$1").replace("T", " ").replace("+00:00", " UTC").replace("Z", " UTC")
  : "--";
const chinaDateText = (value) => {
  if (!value) return "--";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", " UTC+8");
};
const latestTimestamp = (...values) => values
  .filter(Boolean)
  .sort((left, right) => (Date.parse(right) || 0) - (Date.parse(left) || 0))[0] || null;
const syncWarningText = (warnings) => {
  if (!Array.isArray(warnings) || !warnings.length) return "";
  const labels = { drivers: "车手", session_result: "赛果", laps: "圈数", pit: "进站", position: "位置", intervals: "间隔", stints: "轮胎历史", race_control: "赛会消息", weather: "天气记录" };
  const fields = [...new Set(warnings.map((warning) => String(warning).split(":")[0]).map((field) => labels[field] || field))];
  return fields.length ? ` · 部分字段未更新：${fields.join("、")}` : "";
};

const raceControlDriverNames = Object.freeze({
  VER: "维斯塔潘", HAD: "哈贾尔", RUS: "拉塞尔", ANT: "安东内利", LEC: "勒克莱尔", HAM: "汉密尔顿",
  NOR: "诺里斯", PIA: "皮亚斯特里", ALO: "阿隆索", STR: "斯托尔", GAS: "加斯利", COL: "科拉平托",
  LAW: "劳森", LIN: "林德布拉德", HUL: "霍肯伯格", BOR: "博托莱托", ALB: "阿尔本", SAI: "赛恩斯",
  OCO: "奥康", BEA: "比尔曼", PER: "佩雷兹", BOT: "博塔斯", TSU: "角田裕毅",
});

const raceControlPhraseTranslations = [
  ["FIA STEWARDS", "赛事干事"],
  ["RESUMPTION ORDER", "重启顺位"],
  ["ALL PASS HOLDERS MAY ACCESS THE PIT LANE", "所有持证人员均可进入维修区"],
  ["LAPPED CARS MAY NOW OVERTAKE", "被套圈赛车现在可以解套"],
  ["SAFETY CAR WILL USE START/FINISH STRAIGHT", "安全车将通过起发车直道"],
  ["FAILING TO FOLLOW RACE DIRECTORS INSTRUCTIONS", "未按赛事总监的指示执行"],
  ["FAILING TO SERVE TIME PENALTY CORRECTLY", "处罚执行不当"],
  ["LEAVING THE TRACK WITHOUT A JUSTIFIABLE REASON", "无正当理由离开赛道"],
  ["LEAVING THE TRACK AND GAINING AN ADVANTAGE", "离开赛道获得优势"],
  ["GAINING AN ADVANTAGE", "获得优势"],
  ["LEAVING THE TRACK MULTIPLE TIMES", "多次离开赛道"],
  ["FORCING ANOTHER DRIVER OFF THE TRACK", "迫使对手离开赛道"],
  ["FORCING ANOTHER DRIVER OFF TRACK", "迫使对手离开赛道"],
  ["CROSSING THE WHITE LINE AT PIT EXIT", "在维修区出口跨越白线"],
  ["CROSSING THE LINE AT PIT EXIT", "越过维修区出口白线"],
  ["CROSSING THE WHITE LINE AT PIT ENTRY", "在维修区入口跨越白线"],
  ["PRACTICE START INFRINGEMENT", "发车练习违规"],
  ["STARTING PROCEDURE INFRINGEMENT", "违反发车程序"],
  ["OUT OF POSITION AT SAFETY CAR LINE", "通过安全车线时未按规定顺位排序"],
  ["WILL BE INVESTIGATED AFTER THE SESSION", "将会赛后调查"],
  ["WILL BE INVESTIGATED AFTER THE SPRINT", "将会赛后调查"],
  ["WILL BE INVESTIGATED AFTER THE RACE", "将会被赛后调查"],
  ["NO FURTHER INVESTIGATION", "没有进一步调查"],
  ["NO FURTHER ACTION", "不进一步调查"],
  ["PENALTY SERVED INCORRECTLY", "处罚执行不当"],
  ["PENALTY SERVED", "处罚已执行"],
  ["5 SECOND TIME PENALTY", "5秒时间处罚"],
  ["SECOND TIME PENALTY", "秒时间处罚"],
  ["DRIVING ERRATICALLY", "危险驾驶"],
  ["MOVING UNDER BRAKING", "刹车区变线"],
  ["CAUSING A COLLISION", "引发碰撞"],
  ["IMPEDING", "阻挡其他车手"],
  ["IMPEDING ANOTHER DRIVER", "阻挡其他车手"],
  ["UNSAFE RELEASE", "不安全释放"],
  ["UNSAFE RE-JOIN", "不安全回场"],
  ["UNSAFE CONDITION", "赛道存在安全隐患"],
  ["PIT ENTRY VIOLATION", "维修区入口违规"],
  ["LEAVING PIT EXIT ON RED LIGHT", "维修区出口红灯状态下驶出"],
  ["SPEEDING IN THE PIT LANE", "维修区超速"],
  ["YELLOW FLAG INFRINGEMENT", "黄旗下违规"],
  ["IGNORING BLUE FLAGS", "无视蓝旗"],
  ["MAXIMUM DELTA TIME", "超出最大赛段用时"],
  ["BLACK AND WHITE FLAG", "黑白旗"],
  ["CHEQUERED FLAG", "出示方格旗"],
  ["MEDICAL CAR DEPLOYED", "医疗车已出动"],
  ["RECOVERY VEHICLE", "吊车"],
  ["MARSHALS", "赛道工作人员"],
  ["PERSONNEL", "工作人员"],
  ["PIT EXIT CLOSED", "维修区出口关闭"],
  ["PIT EXIT OPEN", "维修区出口开放"],
  ["PIT LANE ENTRY CLOSED", "维修区入口关闭"],
  ["PIT LANE ENTRY OPEN", "维修区入口开放"],
  ["PIT LANE CLOSED", "维修区关闭"],
  ["PIT LANE OPEN", "维修区开放"],
  ["PIT LANE CLEAR", "维修区清理完毕"],
  ["ALL CARS THROUGH THE PIT LANE", "所有赛车通过维修区"],
  ["DRIVE THROUGH PENALTY", "处罚通过维修区"],
  ["VSC DEPLOYED", "虚拟安全车(VSC)已出动"],
  ["VSC ENDING", "虚拟安全车(VSC)即将结束"],
  ["VSC INFRINGEMENT", "虚拟安全车(VSC)下违规"],
  ["SAFETY CAR DEPLOYED", "安全车(SC)已出动"],
  ["SAFETY CAR IN THIS LAP", "安全车本圈结束"],
  ["SAFETY CAR LIGHTS ON", "安全车车灯亮起"],
  ["CAR SAFETY LIGHTS", "车载安全灯"],
  ["SAFETY CAR INFRINGEMENT", "安全车下违规"],
  ["THE SAFETY CAR", "安全车"],
  ["GREEN LIGHT", "绿灯亮起"],
  ["GREEN FLAG", "绿旗"],
  ["RED FLAG", "红旗"],
  ["BLUE FLAG", "蓝旗"],
  ["DOUBLE YELLOW", "双黄旗"],
  ["YELLOW FLAG", "黄旗"],
  ["TRACK CLEAR", "赛道清理完毕"],
  ["TRACK SURFACE SLIPPERY", "路面湿滑"],
  ["WET TRACK", "赛道湿滑"],
  ["LOW GRIP DELTA ACTIVE", "低抓地力时差规则生效"],
  ["LOW GRIP DELTA INACTIVE", "低抓地力时差规则解除"],
  ["LOW GRIP CONDITIONS", "赛道抓地力不足"],
  ["NORMAL GRIP DELTA INACTIVE", "标准抓地力时差规则解除"],
  ["NORMAL GRIP DELTA ACTIVE", "标准抓地力时差规则生效"],
  ["NORMAL GRIP CONDITIONS", "赛道抓地条件正常"],
  ["TRACK LIMITS", "超出赛道限制"],
  ["LAP DELETED", "单圈成绩取消"],
  ["F1 FREE PRACTICE", "练习赛"],
  ["THE F1 RACE", "正赛"],
  ["SPRINT QUALIFYING", "冲刺排位赛"],
  ["QUALIFYING", "排位赛"],
  ["SPRINT", "冲刺赛"],
  ["SESSION START", "比赛开始"],
  ["SESSION STARTED", "比赛开始"],
  ["RACE START", "比赛开始"],
  ["RACE WILL RESUME", "比赛将继续"],
  ["SESSION WILL RESUME", "比赛将继续"],
  ["SESSION RESUMED", "比赛继续"],
  ["SESSION STOPPED", "比赛中止"],
  ["SESSION ABORTED", "比赛中止"],
  ["RACE SUSPENDED", "比赛暂停"],
  ["SESSION FINISHED", "比赛结束"],
  ["RACE CONTROL TEST", "赛会消息测试"],
  ["UPDATE", "更新"],
  ["FIRST CAR TO TAKE THE FLAG", "首辆冲线赛车"],
  ["OVERTAKE ENABLED", "允许使用超车模式"],
  ["OVERTAKE DISABLED", "禁止使用超车模式"],
  ["AWNINGS MAY BE USED", "允许使用遮阳篷(遮雨篷)"],
  ["AWNINGS TO BE REMOVED", "遮阳篷(遮雨篷)将被撤走"],
  ["EXTRA FORMATION LAP", "追加暖胎圈"],
  ["FORMATION LAP WILL START", "暖胎圈将开始"],
  ["WILL START", "将会开始"],
  ["STANDING START", "静态发车"],
  ["OUT OF POSITION", "发车位置违规"],
  ["REVIEWED", "经审核"],
  ["UNDER INVESTIGATION", "调查中"],
  ["NOTED", "被记录"],
  ["INVOLVING", "涉及"],
  ["INCIDENT", "事故"],
  ["RECOVERY VEHICLE", "吊车"],
  ["WAVED BLUE FLAG", "挥动蓝旗"],
  ["TIMED AT", "在"],
  ["IN TRACK SECTOR", "在赛段"],
  ["ON TRACK", "在赛道上"],
  ["FOR CAR", "对车号"],
  ["CARS", "车号"],
  ["CAR", "车号"],
  ["PIT", "维修区"],
  ["TIME", "圈速"],
  ["DELETED", "被删除"],
  ["LAP", "圈"],
  ["TURN", "弯"],
  ["CLEAR", "清理完毕"],
  ["WAVED", "挥动"],
  ["AT", "在"],
  ["AND", "和"],
  ["IS", "是"],
].sort((a, b) => b[0].length - a[0].length);

const escapeRaceControlRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function translateRaceControlMessage(value) {
  let text = String(value ?? "").trim();
  if (!text) return "--";
  const hasLapDeleted = /\bLAP DELETED\b/i.test(text);
  text = text.replace(/\bRISK OF RAIN FOR\s+(.+?)\s+IS\s+(\d+%?)\b/gi, (_, subject, percentage) => {
    const label = /^THE\s+F1\s+RACE$/i.test(subject.trim()) || /^F1\s+RACE$/i.test(subject.trim()) ? "正赛" : subject.trim();
    return `${label}降雨概率是${percentage}`;
  });
  text = text.replace(/\bRISK OF RAIN FOR\s+([^,.;!?]+)$/i, (_, subject) => {
    const label = /^THE\s+F1\s+RACE$/i.test(subject.trim()) || /^F1\s+RACE$/i.test(subject.trim()) ? "正赛" : subject.trim();
    return `${label}降雨概率`;
  });
  text = text.replace(/\bDOUBLE YELLOW IN TRACK SECTOR\s+(\d+)\b/gi, "双黄旗在赛段$1");
  text = text.replace(/\bYELLOW IN TRACK SECTOR\s+(\d+)\b/gi, "黄旗在赛段$1");
  text = text.replace(/\bCLEAR IN TRACK SECTOR\s+(\d+)\b/gi, "清理完毕在赛段$1");
  text = text.replace(/\bYELLOW IN PIT LANE\b/gi, "黄旗在维修区");
  text = text.replace(/\bMARSHALS ON TRACK AT TURN\s+(\d+)\b/gi, "赛道工作人员在赛道上在第$1弯");
  text = text.replace(/\bAT TURN\s+(\d+)\s+LAP\s+(\d+)\b/gi, "在第$2圈第$1弯");
  text = text.replace(/\bAT TURN\s+(\d+)\b/gi, "在第$1弯");
  text = text.replace(/\bTURN\s+(\d+)\b/gi, "第$1弯");
  text = text.replace(/\bLAP\s+(\d+)\b/gi, "第$1圈");
  text = text.replace(/\b(\d{1,3})\s*\(([A-Z]{3})\)/gi, (_, car, code) => `${car} (${raceControlDriverNames[code.toUpperCase()] || code})`);
  text = text.replace(/\bDOUBLE YELLOW\b/gi, hasLapDeleted ? "双黄旗下违规" : "双黄旗");
  text = text.replace(/\bYELLOW FLAG INFRINGEMENT\b/gi, "黄旗下违规");
  text = text.replace(/\bYELLOW FLAG\b/gi, hasLapDeleted ? "黄旗下违规" : "黄旗");
  for (const [source, target] of raceControlPhraseTranslations) {
    text = text.replace(new RegExp(`\\b${escapeRaceControlRegex(source)}\\b`, "gi"), target);
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

function raceControlMessageParts(row) {
  const english = String(row?.text_en || row?.message || "").trim() || "--";
  const chinese = String(row?.text_zh || translateRaceControlMessage(english)).trim() || "--";
  return { english, chinese };
}

const syncTimestampText = (data) => data?.synced_at ? ` · 同步于 ${dateText(data.synced_at)}` : "";
const syncTitle = (data) => Array.isArray(data?.sync_warnings) && data.sync_warnings.length ? "同步完成（部分字段未更新）" : "同步完成";
const sessionLabel = (name) => ({"Practice 1": "练习1", "Practice 2": "练习2", "Practice 3": "练习3", "Day 1": "测试第1天", "Day 2": "测试第2天", "Day 3": "测试第3天", "Sprint Qualifying": "冲刺排位赛", Sprint: "冲刺赛", Qualifying: "排位赛", Race: "正赛"}[name] || name || "会话");
const statusLabel = (row) => row?.is_result_missing ? "无成绩" : row?.dsq ? "DSQ" : row?.dns ? "DNS" : row?.dnf ? "DNF" : "Finished";
const raceSessionNames = new Set(["Race", "Sprint"]);
const qualifyingSessionNames = new Set(["Qualifying", "Sprint Qualifying"]);
const colorNames = { purple: "紫", green: "绿", yellow: "黄", red: "红", blue: "蓝", gray: "灰" };
const colorKey = (value) => colorNames[String(value || "gray").toLowerCase()] ? String(value).toLowerCase() : "gray";
const colorBadge = (value, prefix = "") => `<span class="color-badge color-${colorKey(value)}" title="${esc(value || "gray")}">${esc(prefix)}${colorNames[colorKey(value)]}</span>`;
const colorBadgeOrEmpty = (value, prefix = "") => value == null || value === "" ? "" : colorBadge(value, prefix);
const phaseLabel = (phase) => phase ? phase.toUpperCase() : "";
const isRaceSession = () => raceSessionNames.has(state.activeSession?.session_name);
const isQualifyingSession = () => qualifyingSessionNames.has(state.activeSession?.session_name);
const CURRENT_STANDINGS_SEASON = 2026;
const standingsSeasons = [2026, 2025, 2024, 2023];
const RESULT_COLUMN_STORAGE_KEY = "f1-result-columns-v1";
const resultColumnDefinitions = Object.freeze([
  { key: "position", label: "名次" },
  { key: "car", label: "车号" },
  { key: "driver", label: "车手" },
  { key: "team", label: "车队" },
  { key: "driverId", label: "后台车手ID" },
  { key: "teamId", label: "后台车队ID" },
  { key: "laps", label: "圈数" },
  { key: "time", label: "总时间 / 差距", raceOnly: true },
  { key: "points", label: "积分", raceOnly: true },
  { key: "status", label: "状态" },
  { key: "lastLap", label: "上一圈" },
  { key: "fastestLap", label: "最快圈" },
  { key: "interval", label: "与上一名间距" },
  { key: "gap", label: "与第一名间距" },
  { key: "pit", label: "进站" },
  { key: "nc", label: "NC（计算）", raceOnly: true },
  { key: "tyre", label: "当前轮胎" },
  { key: "trackLimits", label: "超出赛道限制" },
  { key: "miniSectors", label: "小计时段" },
  { key: "sectors", label: "计时段" },
]);
function ensureResultColumnVisibility() {
  if (state.resultColumnVisibility) return state.resultColumnVisibility;
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(RESULT_COLUMN_STORAGE_KEY) || "{}"); } catch { saved = {}; }
  state.resultColumnVisibility = Object.fromEntries(resultColumnDefinitions.map(({ key }) => [key, saved[key] !== false]));
  return state.resultColumnVisibility;
}
function availableResultColumns(live = false) {
  const race = live ? liveIsRaceSession() : isRaceSession();
  return resultColumnDefinitions.filter((column) => !column.raceOnly || race);
}
function visibleResultColumns(live = false) {
  const visibility = ensureResultColumnVisibility();
  return availableResultColumns(live).filter((column) => visibility[column.key] !== false);
}
function orderedResultPickerColumns(live = false) {
  const visibility = ensureResultColumnVisibility();
  return availableResultColumns(live)
    .map((column, index) => ({ column, index }))
    .sort((a, b) => Number(visibility[a.column.key] === false) - Number(visibility[b.column.key] === false) || a.index - b.index)
    .map(({ column }) => column);
}
function resultColumnLabel(column, live = false) {
  if (live || !state.activePhase) return column.label;
  if (column.key === "time") return `${phaseLabel(state.activePhase)} 总时间 / 差距`;
  if (column.key === "lastLap") return `上一圈（${phaseLabel(state.activePhase)}）`;
  if (column.key === "fastestLap") return `最快圈（${phaseLabel(state.activePhase)}）`;
  return column.label;
}
function persistResultColumnVisibility() {
  try { window.localStorage.setItem(RESULT_COLUMN_STORAGE_KEY, JSON.stringify(ensureResultColumnVisibility())); } catch { /* private mode or quota */ }
}
function renderResultColumnPicker(live = false) {
  const root = $(live ? "liveColumnPicker" : "resultColumnPicker");
  if (!root) return;
  const menu = root.querySelector(".column-picker-menu");
  const options = root.querySelector(".column-picker-options");
  if (!menu || !options) return;
  const wasOpen = !menu.hidden;
  options.innerHTML = orderedResultPickerColumns(live).map((column) => `<label class="column-option"><input type="checkbox" data-result-column="${esc(column.key)}" ${ensureResultColumnVisibility()[column.key] !== false ? "checked" : ""}><span>${esc(resultColumnLabel(column, live))}</span></label>`).join("");
  menu.hidden = !wasOpen;
  root.querySelector("[data-column-picker-toggle]")?.setAttribute("aria-expanded", wasOpen ? "true" : "false");
  options.querySelectorAll("input[data-result-column]").forEach((input) => input.addEventListener("change", () => {
    ensureResultColumnVisibility()[input.dataset.resultColumn] = input.checked;
    persistResultColumnVisibility();
    renderResults();
    renderLiveTiming();
  }));
}
function resetResultColumnVisibility() {
  state.resultColumnVisibility = Object.fromEntries(resultColumnDefinitions.map(({ key }) => [key, true]));
  persistResultColumnVisibility();
  renderResults();
  renderLiveTiming();
}
function bindResultColumnPicker(rootId, resetId) {
  const root = $(rootId);
  if (!root) return;
  const toggle = root.querySelector("[data-column-picker-toggle]");
  const menu = root.querySelector(".column-picker-menu");
  const reset = $(resetId);
  if (!toggle || !menu) return;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  reset?.addEventListener("click", (event) => {
    event.stopPropagation();
    resetResultColumnVisibility();
  });
}
const resultColumnCount = () => visibleResultColumns(false).length;
const formatTime = (value) => {
  const total = numeric(value);
  if (total == null) return "--";
  if (total >= 3600) return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${(total % 60).toFixed(3).padStart(6, "0")}`;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(3).padStart(6, "0")}`;
};

async function api(path, options = {}) {
  if (STATIC_MODE) {
    const url = new URL(path, window.location.href);
    if (url.pathname === "/api/seasons") return { data: await staticSeasons(), source: "catalog" };
    if (url.pathname === "/api/meetings") return { data: await staticCatalog(url.searchParams.get("year")), source: "catalog" };
    if (url.pathname === "/api/sessions") return staticSessionList(url.searchParams.get("meeting_key"));
    if (url.pathname === "/api/live-session-data") return staticLiveSessionSnapshot(url.searchParams.get("meeting_key"), url.searchParams.get("session_key"));
    if (url.pathname === "/api/session-data") return staticSessionSnapshot(url.searchParams.get("meeting_key"), url.searchParams.get("session_key"));
    if (url.pathname === "/api/sync-session-data") {
      const body = JSON.parse(options.body || "{}");
      return staticSessionSnapshot(body.meeting_key, body.session_key, { force: true });
    }
    if (url.pathname === "/api/standings") return staticStandings();
    if (url.pathname === "/api/sync-standings") return staticStandings({ force: true });
    return { authenticated: true, username: "用户" };
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) { window.location.replace("login"); throw new Error("登录已失效"); }
  if (!response.ok) throw new Error(payload.error || `请求失败 ${response.status}`);
  return payload;
}

function setConnection(connected, text) {
  $("connectionText").textContent = text;
  $("connectionText").previousElementSibling.classList.toggle("connected", connected);
}

function setStatus(title, meta, loading = false) {
  $("statusTitle").textContent = title;
  $("statusMeta").textContent = meta;
  $("dataStatus").classList.toggle("loading", loading);
}

function renderStandings() {
  const historical = state.standingsSeason !== CURRENT_STANDINGS_SEASON;
  $("standingsSeasonSelect").innerHTML = standingsSeasons.map((year) => `<option value="${year}">${year}</option>`).join("");
  $("standingsSeasonSelect").value = String(state.standingsSeason);
  $("standingsTitle").textContent = `${state.standingsSeason} 年度排名`;
  $("standingsSubtitle").textContent = historical
    ? "官网最终排名历史快照，车手和车队使用后台映射 ID。历史赛季仅供查看，不参与自动或人工同步。"
    : "官网排名快照，车手和车队使用后台映射 ID。每周一 8:00（北京时间）自动同步。";
  $("standingsSyncBtn").hidden = historical;
  const snapshot = state.standings;
  const kind = state.standingsKind;
  const rows = snapshot ? (kind === "teams" ? snapshot.teams : snapshot.drivers) : [];
  const table = $("standingsTable");
  if (!table) return;
  $("standingsTableTitle").textContent = kind === "teams" ? "车队排名" : "车手排名";
  const header = kind === "teams"
    ? "<tr><th>名次</th><th>车队</th><th>后台车队ID</th><th>积分</th></tr>"
    : "<tr><th>名次</th><th>车手</th><th>缩写</th><th>国籍</th><th>车队</th><th>后台车手ID</th><th>后台车队ID</th><th>积分</th></tr>";
  table.querySelector("thead").innerHTML = header;
  table.querySelector("tbody").innerHTML = rows.length
    ? rows.map((row) => kind === "teams"
      ? `<tr><td class="position">${esc(row.position ?? "--")}</td><td><div class="standings-identity">${teamImageHtml(row.teamuid, row.name, "standings-team-image")}<strong>${esc(row.name || "--")}</strong></div></td><td>${esc(row.teamuid ?? "--")}</td><td>${esc(row.points ?? "--")}</td></tr>`
      : `<tr><td class="position">${esc(row.position ?? "--")}</td><td><div class="standings-identity">${driverImageHtml(row._id, row.name, "standings-driver-image")}<strong>${esc(row.name || "--")}</strong></div></td><td><span class="acronym">${esc(row.code || "--")}</span></td><td>${esc(row.nationality || "--")}</td><td><div class="standings-identity standings-team">${teamImageHtml(row.teamuid, row.team, "standings-team-image")}<span>${esc(row.team || "--")}</span></div></td><td>${esc(row._id ?? "--")}</td><td>${esc(row.teamuid ?? "--")}</td><td>${esc(row.points ?? "--")}</td></tr>`).join("")
    : `<tr><td colspan="${kind === "teams" ? 4 : 8}" class="empty-cell">${snapshot ? "暂无年度排名数据" : "点击加载年度排名"}</td></tr>`;
  const syncStatus = snapshot?.sync_status || {};
  const syncAt = latestTimestamp(
    syncStatus.last_success_at,
    syncStatus.last_automatic_at,
    syncStatus.last_manual_at,
    snapshot?.captured_at,
  );
  $("standingsSyncedAt").textContent = syncAt ? `${historical ? "快照时间" : "最近同步"}：${chinaDateText(syncAt)}` : `${historical ? "快照时间" : "最近同步"}：--`;
  $("standingsCount").textContent = snapshot ? `${rows.length} 条` : "--";
  $("standingsSource").textContent = snapshot ? `数据源：官网${historical ? "最终排名" : "排名"}快照` : "数据源：--";
  const alert = $("standingsAlert");
  const failed = syncStatus?.status === "failed" || Boolean(state.standingsError);
  if (alert) {
    if (failed) {
      const attemptedAt = syncStatus?.attempted_at ? `（尝试时间：${chinaDateText(syncStatus.attempted_at)}）` : "";
      const manualFailure = syncStatus?.trigger === "manual";
      const failureTitle = historical ? "历史排名读取失败" : manualFailure ? "年度排名人工同步失败" : "年度排名自动同步失败";
      const detail = syncStatus?.error || state.standingsError || "官网排名同步失败，请查看同步日志";
      const detailSuffix = detail.includes(failureTitle) ? "" : ` ${detail}`;
      alert.textContent = snapshot
        ? `${failureTitle}${attemptedAt}。当前显示上次成功的排名快照。${detailSuffix}`
        : `${failureTitle}。${detail}`;
      alert.hidden = false;
    } else {
      alert.hidden = true;
      alert.textContent = "";
    }
  }
  document.querySelectorAll("[data-standings-kind]").forEach((button) => {
    button.classList.toggle("active", button.dataset.standingsKind === kind);
    button.setAttribute("aria-selected", button.dataset.standingsKind === kind ? "true" : "false");
  });
}

async function loadOfficialStandings({ force = false } = {}) {
  if (force && state.standingsSeason !== CURRENT_STANDINGS_SEASON) return;
  const requestedSeason = force ? CURRENT_STANDINGS_SEASON : state.standingsSeason;
  const button = $("standingsSyncBtn");
  const status = $("standingsStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = force ? "正在刷新官网快照…" : "正在读取官网快照…";
  try {
    const payload = await api(force ? "/api/sync-standings" : `/api/standings?year=${requestedSeason}`, force ? { method: "POST" } : {});
    if (state.standingsSeason !== requestedSeason) return;
    if (Number(payload.data?.season) !== Number(requestedSeason)) throw new Error("年度排名快照与所选赛季不一致");
    state.standings = enrichOfficialStandings(payload.data);
    state.standingsError = null;
    renderStandings();
    if (status) {
      if (payload.data?.sync_status?.status === "failed") status.textContent = "同步失败，显示上次成功快照";
      else if (force && STATIC_MODE) status.textContent = "已读取最新发布快照";
      else if (force) status.textContent = "排名同步成功";
      else if (state.standingsSeason !== CURRENT_STANDINGS_SEASON) status.textContent = `已读取 ${state.standingsSeason} 最终排名`;
      else status.textContent = payload.source === "cache" || payload.source === "local" ? "已读取本地快照" : "排名快照已更新";
    }
  } catch (error) {
    if (state.standingsSeason !== requestedSeason) return;
    state.standingsError = error.message || "年度排名读取失败";
    if (status) status.textContent = error.message || "年度排名读取失败";
    renderStandings();
  } finally {
    if (button) button.disabled = false;
  }
}

function renderLiveTimingSelectors() {
  const live = state.liveTiming;
  const seasonSelect = $("liveSeasonSelect");
  const meetingSelect = $("liveMeetingSelect");
  const sessionSelect = $("liveSessionSelect");
  if (!seasonSelect || !meetingSelect || !sessionSelect) return;
  seasonSelect.value = String(state.season);
  const meetings = state.meetings.length ? state.meetings : [{ meeting_key: 1292, round: 14, meeting_name: "Dutch Grand Prix", country_name: "Netherlands" }];
  meetingSelect.innerHTML = meetings.map((meeting) => {
    const label = meeting.meeting_name || meeting.country_name || "未命名分站";
    const round = meeting.round ? `第 ${meeting.round} 站 · ` : "测试 · ";
    return `<option value="${esc(meeting.meeting_key)}">${esc(round + label)}</option>`;
  }).join("");
  meetingSelect.value = String(live.meetingKey);
  const sessions = live.sessions.length
    ? live.sessions
    : state.sessions.length && Number(state.activeMeeting?.meeting_key) === Number(live.meetingKey)
      ? state.sessions
      : [];
  sessionSelect.innerHTML = sessions.length
    ? sessions.map((session) => `<option value="${esc(session.session_key ?? "")}">${esc(sessionLabel(session.session_name))}${session.session_key == null ? " · 待获取" : ""}</option>`).join("")
    : `<option value="">选择分站后获取节点</option>`;
  sessionSelect.value = live.sessionKey == null ? "" : String(live.sessionKey);
  const sessionTabs = $("liveSessionTabs");
  if (sessionTabs) {
    sessionTabs.innerHTML = sessions.map((session) => `<button class="session-tab${Number(session.session_key) === Number(live.sessionKey) ? " active" : ""}" data-live-session-key="${esc(session.session_key ?? "")}" type="button">${esc(sessionLabel(session.session_name))}${session.session_key == null ? " · 待获取" : ""}</button>`).join("");
    sessionTabs.querySelectorAll("button[data-live-session-key]").forEach((button) => button.addEventListener("click", () => {
      const selectedSession = live.sessions.find((session) => String(session.session_key) === button.dataset.liveSessionKey);
      if (!selectedSession) return;
      stopLivePolling();
      live.sessionKey = selectedSession.session_key;
      live.sessionName = selectedSession.session_name || "Race";
      resetLiveTiming();
      renderLiveTimingSelectors();
    }));
  }
  $("liveStreamId").textContent = live.meetingKey ?? "--";
  $("liveSessionLabel").textContent = `${sessionLabel(live.sessionName)} · ${live.sessionKey ?? "--"}`;
}

function renderLiveMeetingMeta(data = state.liveTiming.data) {
  const live = state.liveTiming;
  const meeting = data?.meeting || {};
  const session = data?.session || {};
  const backend = liveBackendPayload(data);
  const country = meeting.country_name || "";
  const title = meeting.meeting_name || country || (isBackendLivePayload(data) ? "nana 实时推送" : "实时推送");
  const backendType = String(backend.type || backend.name || "").toLowerCase();
  const backendSessionName = backendType.includes("sprint") ? "Sprint" : backendType.includes("race") ? "Race" : "";
  const sessionName = session.session_name || backendSessionName || live.sessionName;
  const subtitle = [country, meeting.location, sessionName ? sessionLabel(sessionName) : ""].filter(Boolean).join(" · ") || "连接后显示当前实时会话";
  const titleNode = $("liveTimingTitle");
  const subtitleNode = $("liveTimingSubtitle");
  if (titleNode) titleNode.textContent = title;
  if (subtitleNode) subtitleNode.textContent = subtitle;
  live.meetingKey = numeric(meeting.meeting_key) ?? live.meetingKey;
  live.sessionKey = numeric(session.session_key) ?? live.sessionKey;
  live.meetingName = meeting.meeting_name || live.meetingName;
  live.sessionName = sessionName || live.sessionName;
}

async function loadLiveTimingSessions(meetingKey) {
  const live = state.liveTiming;
  live.meetingKey = Number(meetingKey);
  // Live Timing uses the preloaded season catalog for node selection. The
  // selected node's data is fetched only from the F1 Telemetry WebSocket.
  const meeting = state.meetings.find((item) => Number(item.meeting_key) === live.meetingKey);
  live.sessions = Array.isArray(meeting?.sessions) ? meeting.sessions.slice() : [];
  const selected = live.sessions.find((session) => session.session_name === live.sessionName) || live.sessions.find((session) => session.session_key != null) || null;
  live.sessionKey = selected?.session_key ?? null;
  live.sessionName = selected?.session_name || "Race";
  renderLiveTimingSelectors();
}

function liveClock(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function displayLapTime(value) {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "string" && /:/.test(value.trim())) return value.trim();
  return formatTime(value);
}

const liveFeedLabels = Object.freeze({
  drivers: "车手",
  session_result: "赛果",
  laps: "圈数",
  pit: "进站",
  position: "位置",
  intervals: "间隔",
  stints: "轮胎历史",
  race_control: "赛会消息",
  weather: "天气记录",
});

function latestLiveRows(rows, key = "driver_number") {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const driver = Number(row?.[key]);
    if (!Number.isFinite(driver)) continue;
    const previous = latest.get(driver);
    const currentTime = Date.parse(row?.date || row?.date_start || "") || 0;
    const previousTime = Date.parse(previous?.date || previous?.date_start || "") || 0;
    if (!previous || currentTime >= previousTime) latest.set(driver, row);
  }
  return latest;
}

function liveResultValue(row, key) {
  const value = row?.[key];
  if (!Array.isArray(value)) return value;
  return value.slice().reverse().find((item) => item !== null && item !== undefined && item !== "") ?? null;
}

function isBackendLivePayload(data) {
  return Boolean(data && typeof data === "object" && !Array.isArray(data)
    && (Array.isArray(data.competitors) || data.winner || data.fields || Array.isArray(data.messages) || data.extra));
}

function liveBackendPayload(data) {
  return data?.mapped && typeof data.mapped === "object" ? data.mapped : isBackendLivePayload(data) ? data : {};
}

function liveMessageTimestamp(row) {
  if (row?.date) return row.date;
  const value = numeric(row?.utc);
  if (value === null) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function liveCompetitorStatus(row, fallback) {
  if (row?.position_desc) return String(row.position_desc);
  const labels = { 301: "运行中", 302: "完成", 303: "DNS", 304: "DSQ", 305: "DNF" };
  return labels[Number(row?.status)] || fallback;
}

function liveWeatherRows(data) {
  if (Array.isArray(data?.weather) && data.weather.length) return data.weather;
  const weather = liveBackendPayload(data)?.extra?.weather;
  return weather && typeof weather === "object" && Object.keys(weather).length
    ? [{ ...weather, date: weather.date || data?.fetched_at }]
    : [];
}

function buildLiveRows(data) {
  const drivers = new Map((data?.drivers || []).map((driver) => [Number(driver.driver_number), driver]));
  const results = new Map((data?.session_result || []).map((result) => [Number(result.driver_number), result]));
  const backend = liveBackendPayload(data);
  const mappedRows = new Map((backend.competitors || []).map((row) => [Number(row.car_number), row]));
  const mappedExtra = backend.extra || {};
  const positions = latestLiveRows(data?.position);
  const intervals = latestLiveRows(data?.intervals);
  const laps = latestLiveRows(data?.laps);
  const pits = (data?.pit || []).reduce((map, row) => {
    const car = Number(row?.driver_number);
    if (!Number.isFinite(car)) return map;
    const current = map.get(car) || { count: 0, latest: null };
    current.count += 1;
    if (!current.latest || (Date.parse(row?.date || "") || 0) >= (Date.parse(current.latest?.date || "") || 0)) current.latest = row;
    map.set(car, current);
    return map;
  }, new Map());
  const lapHistory = new Map();
  for (const lap of Array.isArray(data?.laps) ? data.laps : []) {
    const car = Number(lap?.driver_number);
    const duration = numeric(lap?.lap_duration);
    if (!Number.isFinite(car) || duration == null) continue;
    if (!lapHistory.has(car)) lapHistory.set(car, []);
    lapHistory.get(car).push(lap);
  }
  const cars = new Set([...drivers.keys(), ...results.keys(), ...mappedRows.keys(), ...positions.keys(), ...intervals.keys(), ...laps.keys()]);
  const snapshotTime = Date.parse(data?.fetched_at || "") || Date.now();
  const rows = Array.from(cars).map((car) => {
    const driver = drivers.get(car) || {};
    const result = results.get(car) || {};
    const position = positions.get(car) || {};
    const interval = intervals.get(car) || {};
    const latestLap = laps.get(car) || {};
    const mapped = mappedRows.get(car) || {};
    const history = lapHistory.get(car) || [];
    const bestLap = history.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0];
    const pit = pits.get(car);
    const lastActivity = [latestLap.date_start, interval.date, position.date, pit?.latest?.date].map((value) => Date.parse(value || "") || 0).sort((a, b) => b - a)[0] || null;
    const resultPosition = numeric(result.position);
    const livePosition = numeric(position.position);
    const pitAt = Date.parse(pit?.latest?.date || "") || 0;
    const recentPit = pitAt > 0 && pitAt >= (Date.parse(latestLap.date_start || "") || 0) && snapshotTime - pitAt < 120000;
    const fallbackStatus = result.dsq ? "DSQ" : result.dns ? "DNS" : result.dnf ? "DNF" : recentPit ? "进站" : data?.session?.date_end && Date.parse(data.session.date_end) < snapshotTime ? "完成" : "运行中";
    const status = liveCompetitorStatus(mapped, fallbackStatus);
    const mappedId = mapped._id ?? mapped.id ?? resolveBackendDriverId(driver);
    const mappedTeamId = mapped.teamuid ?? mapped.team_id ?? sharedResolveBackendTeamId(driver.team_name);
    const gap = mapped.gap_to_leader || liveResultValue(result, "gap_to_leader") || interval.gap_to_leader || null;
    const intervalValue = mapped.interval || liveResultValue(result, "interval") || interval.interval || null;
    const mappedLastLap = mappedId != null ? mappedExtra.last_lap_time?.[String(mappedId)] : null;
    const mappedBestLap = mapped.fastest_lap_time || null;
    const directSectors = [1, 2, 3].map((sector) => ({
      sector,
      time: result[`duration_sector_${sector}`] == null ? "" : Number(result[`duration_sector_${sector}`]).toFixed(3),
      best_time: "",
      time_color: "",
      best_time_color: "",
    }));
    const directMiniSectors = [1, 2, 3].map((sector) => ({
      sector,
      mini_sectors: (Array.isArray(result[`segments_sector_${sector}`]) ? result[`segments_sector_${sector}`] : []).map((status, index) => ({ mini_sector: index + 1, status, color: colorFromStatus(status) })),
    }));
    const directTyreHistory = (data?.stints || []).filter((stint) => Number(stint.driver_number) === car).slice().sort((a, b) => Number(a.stint_number) - Number(b.stint_number));
    const directTyreInfo = directTyreHistory.at(-1) || null;
    const profile = liveDriverProfiles.get(Number(mappedId)) || {};
    const name = driver.full_name || `${driver.first_name || ""} ${driver.last_name || ""}`.trim() || profile.name || `车手 ${car}`;
    return {
      position: numeric(mapped.position) ?? resultPosition ?? livePosition ?? null,
      car,
      name,
      code: driver.name_acronym || profile.code || "",
      team: driver.team_name || liveTeamNames.get(Number(mappedTeamId)) || "--",
      driverId: mappedId,
      teamId: mappedTeamId,
      lap: mapped.laps ?? numeric(result.number_of_laps) ?? numeric(latestLap.lap_number),
      lastLap: mappedLastLap || result.last_lap_duration || latestLap.lap_duration,
      bestLap: mappedBestLap || result.best_lap_duration || bestLap?.lap_duration || null,
      gap,
      interval: intervalValue,
      time: mapped.time && typeof mapped.time === "object" ? mapped.time.value ?? null : mapped.time ?? null,
      points: mapped.points ?? result.points ?? null,
      status,
      positionDesc: mapped.position_desc ?? "",
      grid: mapped.grid ?? null,
      lapsLed: mapped.laps_led ?? null,
      pitCount: mapped.pitstop_count ?? mapped.pitstop ?? pit?.count ?? 0,
      mapped,
      extra: mappedId != null ? {
        lastLapColor: mappedExtra.last_lap_time_color?.[String(mappedId)] || null,
        bestLapColor: mappedExtra.best_lap_time_color?.[String(mappedId)] || null,
        sectors: mappedExtra.sectors?.[String(mappedId)] || directSectors,
        miniSectors: mappedExtra.mini_sectors?.[String(mappedId)] || mappedExtra.mini_sectors_data?.[String(mappedId)] || directMiniSectors,
        tyreInfo: mappedExtra.tire_info?.[String(mappedId)] || directTyreInfo,
        tyreHistory: mappedExtra.tire_history?.[String(mappedId)] || directTyreHistory,
        trackLimits: mappedExtra.track_limits?.[String(mappedId)] ?? null,
      } : null,
      updatedAt: lastActivity ? new Date(lastActivity).toISOString() : data?.fetched_at,
    };
  });
  rows.sort((a, b) => {
    const aPosition = a.position == null ? Infinity : a.position;
    const bPosition = b.position == null ? Infinity : b.position;
    if (aPosition !== bPosition) return aPosition - bPosition;
    const aGap = numeric(a.gap);
    const bGap = numeric(b.gap);
    return (aGap ?? Infinity) - (bGap ?? Infinity) || a.car - b.car;
  });
  rows.forEach((row, index) => { if (row.position == null) row.position = index + 1; });
  return rows;
}

function buildLiveEvents(data) {
  const backendMessages = liveBackendPayload(data).messages;
  const messages = Array.isArray(data?.race_control) && data.race_control.length ? data.race_control : Array.isArray(backendMessages) ? backendMessages : [];
  return messages
    .slice()
    .sort((a, b) => (Date.parse(liveMessageTimestamp(b) || "") || 0) - (Date.parse(liveMessageTimestamp(a) || "") || 0))
    .map((row, index) => {
      const { english, chinese } = raceControlMessageParts(row);
      return { sequence: index + 1, receivedAt: liveMessageTimestamp(row), lap: row.lap_number ?? row.lap ?? "--", typeLabel: row.category || "赛会消息", english, chinese, message: english };
    });
}

function buildLiveLogs(data) {
  const errors = new Set((data?.live_errors || []).map((value) => String(value).split(":")[0]));
  return Object.keys(liveFeedLabels).map((key, index) => ({
    sequence: index + 1,
    title: errors.has(key) ? "读取失败" : "已更新",
    detail: `${liveFeedLabels[key]} · ${errors.has(key) ? "本次更新无数据" : "已替换为最新数据"}`,
    ok: !errors.has(key),
    at: data?.fetched_at,
  }));
}

const liveIsRaceSession = () => raceSessionNames.has(state.liveTiming.sessionName);
const liveResultColumnCount = () => visibleResultColumns(true).length;
const liveResultHeaderHtml = () => {
  renderResultColumnPicker(true);
  return `<tr>${visibleResultColumns(true).map((column) => `<th>${esc(resultColumnLabel(column, true))}</th>`).join("")}</tr>`;
};

function renderLiveSourceControl() {
  const live = state.liveTiming;
  const select = $("liveSourceSelect");
  const hint = $("liveTimingHint");
  const footer = $("liveSourceFooter");
  const bridge = live.source === "nana" || live.source === "bridge";
  if (select) select.value = bridge ? "nana" : "f1telemetry";
  if (hint) hint.textContent = bridge
    ? "数据源：nana；另一套后台 POST 最新快照，本页面通过 SSE 接收并覆盖当前状态，不保存历史。"
    : "数据源：F1 Telemetry 实时接口；不区分历史分站和节点，只覆盖当前实时快照，不写入本地缓存。";
  if (footer) footer.textContent = bridge ? "数据源：nana" : "数据源：F1 Telemetry 实时接口";
}

function renderLiveTiming() {
  const live = state.liveTiming;
  const table = $("liveTimingTable");
  if (!table) return;
  renderLiveSourceControl();
  renderLiveMeetingMeta();
  const race = liveIsRaceSession();
  table.querySelector("thead").innerHTML = liveResultHeaderHtml();
  const query = String(live.search || "").trim().toLowerCase();
  const filteredRows = live.rows.filter((row) => !query || [row.car, row.name, row.team, row.code].some((value) => String(value ?? "").toLowerCase().includes(query)));
  table.querySelector("tbody").innerHTML = filteredRows.length
    ? filteredRows.map((row) => {
      const rowIndex = live.rows.indexOf(row);
      const previous = live.rows[rowIndex - 1];
      const currentTyre = row.extra?.tyreInfo?.compound;
      const currentTyreLaps = row.extra?.tyreInfo?.total_laps;
      const previousGap = rowIndex === 0 ? "--" : row.interval || (numeric(row.gap) != null && numeric(previous?.gap) != null ? displayGap(Math.max(0, numeric(row.gap) - numeric(previous.gap))) : "--");
      const statusClass = row.status === "进站" ? "is-pit" : row.status === "运行中" ? "is-running" : "is-warning";
      const cells = {
        position: `<td class="position">${esc(row.position ?? "--")}</td>`,
        car: `<td>${esc(row.car)}</td>`,
        driver: `<td class="driver-cell"><strong>${esc(row.name)}</strong><span class="driver-code">${esc(row.code)}</span></td>`,
        team: `<td>${esc(row.team)}</td>`,
        driverId: `<td>${esc(row.driverId ?? "--")}</td>`,
        teamId: `<td>${esc(row.teamId ?? "--")}</td>`,
        laps: `<td>${esc(row.lap ?? "--")}</td>`,
        time: `<td>${esc(row.time || displayGap(row.gap))}</td>`,
        points: `<td>${esc(row.points ?? "--")}</td>`,
        status: `<td><span class="live-row-status ${statusClass}">${esc(row.status)}</span></td>`,
        lastLap: `<td>${displayLapTime(row.lastLap)} ${colorBadgeOrEmpty(row.extra?.lastLapColor)}</td>`,
        fastestLap: `<td>${displayLapTime(row.bestLap)} ${colorBadgeOrEmpty(row.extra?.bestLapColor)}</td>`,
        interval: `<td>${esc(previousGap)}</td>`,
        gap: `<td>${esc(displayGap(row.gap))}</td>`,
        pit: `<td>${esc(row.pitCount ?? "--")}</td>`,
        nc: `<td>${esc(row.positionDesc || "--")}</td>`,
        tyre: `<td>${currentTyre ? tyreChip(currentTyre, `${currentTyre} · ${currentTyreLaps ?? "--"} 圈`) : "--"}</td>`,
        trackLimits: `<td>${esc(row.extra?.trackLimits ?? "--")}</td>`,
        miniSectors: `<td><div class="row-colors">${miniSectorSummary(row.extra?.miniSectors)}</div></td>`,
        sectors: `<td>${sectorSummary(row.extra?.sectors)}</td>`,
      };
      return `<tr data-live-car="${esc(row.car)}" class="${live.selectedDriver === row.car ? "selected" : ""}">${visibleResultColumns(true).map((column) => cells[column.key]).join("")}</tr>`;
    }).join("")
    : `<tr><td colspan="${liveResultColumnCount()}" class="empty-cell">${live.rows.length ? "没有匹配的车手" : "点击开始推送"}</td></tr>`;
  table.querySelectorAll("tr[data-live-car]").forEach((tr) => tr.addEventListener("click", () => {
    live.selectedDriver = Number(tr.dataset.liveCar);
    renderLiveTiming();
  }));
  const data = live.data || {};
  const backend = liveBackendPayload(data);
  const backendLaps = numeric(backend.fields?.laps_completed) ?? numeric(backend.fields?.laps);
  $("liveMetricDrivers").textContent = number((backend.competitors || data.drivers || []).length);
  $("liveMetricLaps").textContent = number(backendLaps ?? Math.max(0, ...(data.laps || []).map((lap) => Number(lap.lap_number) || 0)));
  $("liveMetricWeather").textContent = number(liveWeatherRows(data).length);
  $("liveMetricMessages").textContent = number((backend.messages || data.race_control || []).length);
  $("liveRowsBadge").textContent = `${filteredRows.length} / ${live.rows.length} 条`;
  $("liveSequenceBadge").textContent = `更新 ${live.sequence ? `#${String(live.sequence).padStart(3, "0")}` : "--"}`;
  $("liveEventsBadge").textContent = `${live.events.length} 条`;
  const messageLimit = live.messageView === "all" ? live.events.length : Number(live.messageView);
  const visibleEvents = live.events.slice(0, Number.isFinite(messageLimit) ? messageLimit : live.events.length);
  const language = live.messageLanguage || "both";
  $("liveEventTable").querySelector("tbody").innerHTML = visibleEvents.length
    ? visibleEvents.map((event) => {
      const messageHtml = language === "en"
        ? `<div class="message-line message-line-en">${esc(event.english)}</div>`
        : language === "zh"
          ? `<div class="message-line message-line-zh">${esc(event.chinese)}</div>`
          : `<div class="message-lines"><div class="message-line message-line-en">${esc(event.english)}</div><div class="message-line message-line-zh">${esc(event.chinese)}</div></div>`;
      return `<tr><td>${liveClock(event.receivedAt)}</td><td>${esc(event.lap ?? "--")}</td><td class="wrap-cell">${messageHtml}</td></tr>`;
    }).join("")
    : `<tr><td colspan="3" class="empty-cell">暂无赛会消息</td></tr>`;
  renderLiveDriverDetails();
  renderLiveWeather();
  renderLiveTyres();
  $("liveStatusTitle").textContent = live.loading ? "正在更新" : live.running ? "实时更新中" : live.received ? "已停止" : "等待连接";
  $("liveStatusPulse").classList.toggle("connected", live.running);
  const transport = live.source === "nana" || live.source === "bridge" ? "SSE 持续连接" : "WebSocket 持续连接";
  $("liveStatusMeta").textContent = live.lastAt ? `最后更新 ${liveClock(live.lastAt)} · ${transport}${live.errors ? ` · ${live.errors} 个字段失败` : ""}` : "尚未接收到消息";
  $("liveLoadBtn").innerHTML = `<span>${live.running ? "实时更新中" : "开始实时"}</span><span aria-hidden="true">${live.running ? "●" : "▶"}</span>`;
  $("liveLoadBtn").disabled = live.loading;
  $("liveSyncBtn").disabled = live.loading;
  $("liveCacheLabel").textContent = live.lastAt ? `实时状态：${live.running ? "连接中" : "已停止"}` : "实时状态：等待数据";
}

function renderLiveDriverDetails() {
  const container = $("liveDriverDetails");
  if (!container) return;
  const row = state.liveTiming.rows.find((item) => item.car === state.liveTiming.selectedDriver);
  if (!row) {
    container.innerHTML = `<span class="placeholder-icon">＋</span><span>点击上方赛果中的车手行</span><small>查看上一圈、计时段、轮胎和超出赛道限制</small>`;
    return;
  }
  const extension = row.extra || {};
  const tyre = extension.tyreInfo;
  const tyreLaps = tyre?.total_laps ?? "--";
  const historyLaps = (extension.tyreHistory || []).reduce((sum, item) => sum + (Number(item.total_laps) || 0), 0);
  container.innerHTML = `<div class="detail-content">${detailIdentityHtml({ driverId: row.driverId, teamId: row.teamId, name: row.name, car: row.car, team: row.team })}<div class="detail-grid">
    <div class="detail-item"><label>上一圈</label><strong>${displayLapTime(row.lastLap)} ${colorBadgeOrEmpty(extension.lastLapColor)}</strong></div>
    <div class="detail-item"><label>最快圈</label><strong>${displayLapTime(row.bestLap)} ${colorBadgeOrEmpty(extension.bestLapColor)}</strong></div>
    <div class="detail-item"><label>当前轮胎</label><strong>${tyre ? tyreChip(tyre.compound, `${tyre.compound} · ${tyreLaps} 圈`) : "--"}</strong></div>
    <div class="detail-item"><label>进站次数</label><strong>${esc(row.pitCount ?? "--")}</strong></div>
    <div class="detail-item"><label>总圈数</label><strong>${esc(row.lap ?? "--")}</strong></div>
    <div class="detail-item"><label>超出赛道限制</label><strong>${esc(extension.trackLimits ?? "--")}</strong></div>
    <div class="detail-item"><label>轮胎历史圈数</label><strong>${esc(historyLaps || "--")}</strong></div>
    <div class="detail-item"><label>计时段</label><strong>${sectorSummary(extension.sectors)}</strong></div>
  </div><div class="detail-color-block"><label>小计时段</label>${miniSectorSummary(extension.miniSectors)}</div></div>`;
}

function renderLiveWeather() {
  const data = state.liveTiming.data || {};
  const weather = liveWeatherRows(data).slice().sort((a, b) => (Date.parse(a.date || "") || 0) - (Date.parse(b.date || "") || 0));
  const latest = weather.at(-1);
  const badge = $("liveWeatherBadge");
  if (badge) badge.textContent = weather.length ? `${weather.length} 条` : "--";
  if (!latest) {
    $("liveWeatherSnapshot").innerHTML = `<div class="empty-cell">暂无天气记录</div>`;
    $("liveWeatherTable").querySelector("tbody").innerHTML = `<tr><td colspan="8" class="empty-cell">暂无天气记录</td></tr>`;
    return;
  }
  $("liveWeatherSnapshot").innerHTML = [["气温", `${fixed(latest.air_temperature, 1)} °C`], ["赛道", `${fixed(latest.track_temperature, 1)} °C`], ["湿度", `${fixed(latest.humidity, 1)} %`], ["风速", `${fixed(latest.wind_speed, 1)} m/s`], ["风向", `${fixed(latest.wind_direction, 0)}°`]].map(([label, value]) => `<div class="weather-item"><label>${label}</label><strong>${esc(value)}</strong></div>`).join("");
  const limit = state.liveTiming.weatherView === "all" ? weather.length : Number(state.liveTiming.weatherView);
  const visible = weather.slice(Math.max(0, weather.length - (Number.isFinite(limit) ? limit : weather.length))).reverse();
  $("liveWeatherTable").querySelector("tbody").innerHTML = visible.map((row) => `<tr><td>${esc(dateText(row.date))}</td><td>${esc(fixed(row.air_temperature, 1))} °C</td><td>${esc(fixed(row.track_temperature, 1))} °C</td><td>${esc(fixed(row.humidity, 1))} %</td><td>${esc(fixed(row.pressure, 1))} hPa</td><td>${esc(fixed(row.wind_speed, 1))} m/s</td><td>${esc(fixed(row.wind_direction, 0))}°</td><td>${row.rainfall ? "是" : "否"}</td></tr>`).join("");
}

function renderLiveTyres() {
  const table = $("liveTyreTable");
  if (!table) return;
  const rows = state.liveTiming.rows.filter((row) => Array.isArray(row.extra?.tyreHistory) && row.extra.tyreHistory.length);
  $("liveTyreBadge").textContent = rows.length ? `${rows.length} 位车手` : "--";
  table.querySelector("tbody").innerHTML = rows.length
    ? rows.map((row) => {
      const stints = row.extra.tyreHistory.slice();
      const strategy = stints.map((stint) => {
        const laps = stint.lap_start != null || stint.lap_end != null ? `L${stint.lap_start ?? "--"}-${stint.lap_end ?? "--"}` : `${stint.total_laps ?? "--"} 圈`;
        return `<span class="tyre-strategy-item">${tyreChip(stint.compound, stint.compound || "--")} <span>${esc(laps)}</span></span>`;
      }).join(`<span class="strategy-arrow" aria-hidden="true">→</span>`);
      const last = stints.at(-1);
      const totalLaps = stints.reduce((sum, stint) => sum + (Number(stint.total_laps) || 0), 0);
      const liveTyre = row.extra.tyreInfo || last;
      return `<tr><td>${esc(row.name)} <span class="acronym">${esc(row.code)}</span></td><td>${esc(row.car)}</td><td class="wrap-cell tyre-strategy">${strategy}</td><td>${esc(row.pitCount ?? "--")}</td><td>${esc(totalLaps || "--")}</td><td>${liveTyre ? tyreChip(liveTyre.compound, liveTyre.compound) : "--"}</td></tr>`;
    }).join("")
    : `<tr><td colspan="6" class="empty-cell">暂无轮胎记录</td></tr>`;
}

function resetLiveTiming() {
  const live = state.liveTiming;
  stopLivePolling();
  live.token += 1;
  live.data = null;
  live.rows = [];
  live.events = [];
  live.logs = [];
  live.selectedDriver = null;
  live.search = "";
  live.received = 0;
  live.errors = 0;
  live.sequence = 0;
  live.running = false;
  live.started = false;
  live.lastAt = null;
  live.loading = false;
  renderLiveTiming();
}

function openLiveBridgeStream({ onState, onError, onClose } = {}) {
  if (STATIC_MODE || typeof EventSource !== "function") {
    throw new Error("nana 推送需要运行本地 Node 服务");
  }
  const eventSource = new EventSource("/api/live-timing/stream");
  let closedByCaller = false;
  const stateHandler = (event) => {
    try {
      onState?.(JSON.parse(event.data));
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("实时推送数据格式无效"));
    }
  };
  eventSource.addEventListener("state", stateHandler);
  eventSource.onerror = () => {
    if (!closedByCaller) onError?.(new Error("nana 推送入口连接失败"));
  };
  const requestState = async () => {
    try {
      const response = await fetch("/api/live-timing", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `实时推送读取失败 ${response.status}`);
      if (!payload.data) throw new Error("nana 尚未推送实时数据");
      onState?.(payload.data);
      return true;
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };
  return {
    requestState,
    close() {
      closedByCaller = true;
      eventSource.close();
      onClose?.();
    },
  };
}

async function loadLiveTimingData() {
  const live = state.liveTiming;
  if (live.stream) {
    live.loading = true;
    live.stream.requestState();
    renderLiveTiming();
    return true;
  }
  if (live.loading) return false;
  const token = live.token;
  live.loading = true;
  const bridge = live.source === "nana" || live.source === "bridge";
  setConnection(false, bridge ? "正在连接 nana" : "正在连接实时接口");
  renderLiveTiming();
  try {
    const openStream = bridge ? openLiveBridgeStream : openF1TelemetryStream;
    live.stream = openStream({
      requestedMeetingKey: null,
      requestedSessionKey: null,
      timeoutMs: 30000,
      onState: (data) => {
        if (token !== live.token || state.activeView !== "liveTiming") return;
        live.data = isBackendLivePayload(data) ? data : enrichBackendMapping(data || {});
        renderLiveMeetingMeta(live.data);
        setConnection(true, "实时接口已连接");
        live.rows = buildLiveRows(live.data);
        live.events = buildLiveEvents(live.data);
        live.logs = buildLiveLogs(live.data);
        live.received += 1;
        live.errors = Array.isArray(live.data.live_errors) ? live.data.live_errors.length : 0;
        live.sequence += 1;
        live.lastAt = live.data.fetched_at || new Date().toISOString();
        live.loading = false;
        renderLiveTiming();
      },
      onError: (error) => {
        if (token !== live.token) return;
        setConnection(false, "实时接口连接失败");
        live.errors = 1;
        live.loading = false;
        live.logs = [{ sequence: 1, title: "更新失败", detail: error.message || "数据源请求失败", ok: false, at: new Date().toISOString() }];
        renderLiveTiming();
      },
      onClose: () => {
        if (token !== live.token) return;
        setConnection(false, bridge ? "nana 推送已断开" : "实时接口已断开");
        live.stream = null;
        live.running = false;
        live.loading = false;
        renderLiveTiming();
      },
    });
    live.running = true;
    live.started = true;
    renderLiveTiming();
    return true;
  } catch (error) {
    if (token === live.token) {
      live.errors = 1;
      setConnection(false, "实时接口连接失败");
      live.logs = [{ sequence: 1, title: "更新失败", detail: error.message || "数据源请求失败", ok: false, at: new Date().toISOString() }];
      renderLiveTiming();
    }
    return false;
  } finally {
    if (token === live.token && !live.stream) {
      live.loading = false;
      renderLiveTiming();
    }
  }
}

function stopLivePolling() {
  const live = state.liveTiming;
  if (live.timer) window.clearInterval(live.timer);
  live.timer = null;
  live.stream?.close();
  live.stream = null;
  live.running = false;
  live.token += 1;
}

function startLivePolling() {
  const live = state.liveTiming;
  if (live.stream) return;
  live.running = true;
  live.started = true;
  live.token += 1;
  if (live.timer) window.clearInterval(live.timer);
  loadLiveTimingData();
  renderLiveTiming();
}

function setActiveView(view) {
  state.activeView = ["schedule", "standings", "liveTiming", "dataGuide"].includes(view) ? view : "schedule";
  $("scheduleView").hidden = state.activeView !== "schedule";
  $("standingsView").hidden = state.activeView !== "standings";
  $("liveTimingView").hidden = state.activeView !== "liveTiming";
  $("dataGuideView").hidden = state.activeView !== "dataGuide";
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.activeView));
  if (state.activeView === "standings" && !state.standings) loadOfficialStandings();
  if (state.activeView === "liveTiming") {
    renderLiveTimingSelectors();
    renderLiveTiming();
  } else {
    stopLivePolling();
  }
}

function resultHeaderHtml() {
  renderResultColumnPicker(false);
  return `<tr>${visibleResultColumns(false).map((column) => `<th>${esc(resultColumnLabel(column))}</th>`).join("")}</tr>`;
}

function renderResultHeader() {
  $("resultsTable").querySelector("thead").innerHTML = resultHeaderHtml();
}

function resetDataPanels(message = "选择节点后自动同步") {
  ["metricDrivers", "metricLaps", "metricWeather", "metricMessages"].forEach((id) => $(id).textContent = "--");
  renderResultHeader();
  $("resultsTable").querySelector("tbody").innerHTML = `<tr><td colspan="${resultColumnCount()}" class="empty-cell">${esc(message)}</td></tr>`;
  $("resultsFooter").textContent = message;
  $("driverDetails").innerHTML = `<span class="placeholder-icon">＋</span><span>点击上方赛果中的车手行</span><small>查看上一圈、计时段、轮胎和超出赛道限制</small>`;
  $("weatherSnapshot").innerHTML = `<div class="empty-cell">暂无天气记录</div>`;
  $("weatherTable").querySelector("tbody").innerHTML = `<tr><td colspan="8" class="empty-cell">暂无天气记录</td></tr>`;
  $("tyreTable").querySelector("tbody").innerHTML = `<tr><td colspan="6" class="empty-cell">暂无轮胎记录</td></tr>`;
  $("messageTable").querySelector("tbody").innerHTML = `<tr><td colspan="3" class="empty-cell">暂无赛会消息</td></tr>`;
  ["weatherBadge", "tyreBadge", "messageBadge"].forEach((id) => $(id).textContent = "--");
}

function renderMeetings() {
  const select = $("meetingSelect");
  const options = state.meetings.map((meeting) => {
    const testing = meeting.meeting_name === "Pre-Season Testing";
    const label = testing ? `${meeting.meeting_name} · ${meeting.location || meeting.country_name || ""}` : (meeting.meeting_name || meeting.country_name || "未命名分站");
    const round = meeting.round ? `第 ${meeting.round} 站 · ` : "测试 · ";
    const cancelled = meeting.is_cancelled ? " · 已取消" : "";
    return `<option value="${esc(meeting.meeting_key)}">${esc(round + label + cancelled)}</option>`;
  }).join("");
  select.innerHTML = `<option value="">请选择分站</option>${options}`;
  select.value = state.activeMeeting ? String(state.activeMeeting.meeting_key) : "";
}

function renderSeasonOptions() {
  const years = state.seasons.length ? state.seasons : [state.season];
  const options = years.map((year) => `<option value="${year}">${year}</option>`).join("");
  for (const id of ["seasonSelect", "liveSeasonSelect"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = options;
    select.value = String(state.season);
  }
}

function sessionNodeKey(session, index, phase = null) {
  const base = session.session_key != null ? String(session.session_key) : `pending:${session.meeting_key || state.activeMeeting?.meeting_key}:${index}`;
  return phase ? `${base}:${phase}` : base;
}

function sessionNodes() {
  const nodes = [];
  state.sessions.forEach((session, index) => {
    nodes.push({ key: sessionNodeKey(session, index), label: sessionLabel(session.session_name), session, phase: null, index });
    if (["Qualifying", "Sprint Qualifying"].includes(session.session_name)) {
      for (const phase of ["q1", "q2", "q3"]) nodes.push({ key: sessionNodeKey(session, index, phase), label: `${sessionLabel(session.session_name)} · ${phaseLabel(phase)}`, session, phase, index });
    }
  });
  return nodes;
}

function renderSessionControls() {
  const select = $("sessionSelect");
  const nodes = sessionNodes();
  if (!nodes.length) {
    select.innerHTML = `<option value="">${state.activeMeeting ? "暂无可用节点" : "请先选择分站"}</option>`;
    select.disabled = true;
    $("sessionTabs").innerHTML = "";
    $("syncBtn").disabled = true;
    $("refreshBtn").disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = nodes.map((node) => `<option value="${esc(node.key)}">${esc(node.label)}${node.session.is_catalog_placeholder ? " · 待获取" : ""}</option>`).join("");
  const activeNode = nodes.find((node) => node.session === state.activeSession && node.phase === state.activePhase);
  const activeKey = activeNode?.key || nodes[0]?.key;
  if (activeKey) select.value = activeKey;
  $("syncBtn").disabled = state.activeSession?.session_key == null;
  $("refreshBtn").disabled = false;
  $("sessionTabs").innerHTML = nodes.map((node) => `<button class="session-tab${node.phase ? " phase" : ""}${node.key === activeKey ? " active" : ""}" data-session-node="${esc(node.key)}">${esc(node.label)}</button>`).join("");
  $("sessionTabs").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectSessionNode(button.dataset.sessionNode)));
}

function setMeetingMeta(meeting, session) {
  if (!meeting) {
    $("pageTitle").textContent = "请选择分站";
    $("pageSubtitle").textContent = "选择分站后再选择会话节点";
    $("meetingKeyLabel").textContent = "--";
    $("sessionKeyLabel").textContent = "--";
    return;
  }
  const name = meeting?.meeting_name || meeting?.country_name || "分站";
  $("pageTitle").textContent = name;
  const phase = state.activePhase ? ` · ${phaseLabel(state.activePhase)}` : "";
  $("pageSubtitle").textContent = `${meeting?.country_name || ""}${meeting?.location ? ` · ${meeting.location}` : ""} · ${session ? sessionLabel(session.session_name) : "选择一个会话节点"}${phase}`;
  $("meetingKeyLabel").textContent = meeting?.meeting_key ?? "--";
  $("sessionKeyLabel").textContent = session?.session_key ?? "--";
}

function clearMeetingSelection() {
  state.dataRequestId += 1;
  state.activeMeeting = null;
  state.sessions = [];
  state.activeSession = null;
  state.activePhase = null;
  state.data = null;
  state.selectedDriver = null;
  renderSessionControls();
  setMeetingMeta(null, null);
  setStatus("等待选择分站", "请选择一个分站", false);
  resetDataPanels("请选择分站");
  $("cachePathLabel").textContent = "缓存状态：--";
}

async function loadMeetings() {
  renderSeasonOptions();
  let meetingError = null;
  try {
    const payload = await api(`/api/meetings?year=${state.season}`);
    state.meetings = (payload.data || []).slice().sort((a, b) => (a.round ?? 999) - (b.round ?? 999) || Date.parse(a.date_start || 0) - Date.parse(b.date_start || 0));
    setConnection(payload.source === "openf1" || payload.source === "cache", payload.source === "openf1" ? "数据源已连接" : payload.source === "catalog" ? "本地赛季目录" : "本地缓存");
  } catch (error) {
    state.meetings = [];
    meetingError = error;
    setConnection(false, "离线演示数据");
  }
  clearMeetingSelection();
  renderMeetings();
  renderLiveTimingSelectors();
  if (meetingError) {
    setStatus("无法读取分站列表", "请检查本地目录文件", false);
    resetDataPanels(meetingError.message || "无法读取分站列表");
  }
}

async function loadSeasons() {
  try {
    const payload = await api("/api/seasons");
    const years = [...new Set((payload.data || []).map(Number).filter(Number.isInteger))].sort((a, b) => b - a);
    state.seasons = years.length ? years : [state.season];
    if (!state.seasons.includes(state.season)) state.season = state.seasons[0];
  } catch {
    state.seasons = [state.season];
  }
  renderSeasonOptions();
}

async function initialiseScheduleCatalog() {
  await loadSeasons();
  await loadMeetings();
}

async function loadSessions(meetingKey) {
  if (!meetingKey) {
    clearMeetingSelection();
    renderMeetings();
    return;
  }
  try {
    const payload = await api(`/api/sessions?meeting_key=${meetingKey}`);
    state.sessions = payload.data || [];
    if (payload.source === "openf1") setConnection(true, "数据源已连接");
    else if (payload.source === "cache" || payload.source === "local") setConnection(true, "本地缓存");
    else if (payload.source === "catalog") setConnection(false, "本地节点目录 · 待接口获取");
  } catch (error) {
    state.sessions = state.activeMeeting?.sessions || [];
    setConnection(false, "本地节点目录 · 待接口获取");
  }
  state.activeSession = state.sessions.find((session) => session.session_name === "Race") || state.sessions[0] || null;
  state.activePhase = null;
  renderSessionControls();
  setMeetingMeta(state.activeMeeting, state.activeSession);
  if (state.activeSession) await loadCurrentData();
}

async function selectSessionNode(key) {
  const node = sessionNodes().find((item) => item.key === String(key));
  state.activeSession = node?.session || null;
  state.activePhase = node?.phase || null;
  renderSessionControls();
  setMeetingMeta(state.activeMeeting, state.activeSession);
  await loadCurrentData();
}

const statusColors = { 0: "red", 2048: "yellow", 2049: "green", 2051: "purple", 2064: "blue" };
const tyreClass = (compound) => {
  const value = String(compound || "unknown").toLowerCase();
  return ["soft", "medium", "hard", "intermediate", "wet"].includes(value) ? value : "unknown";
};
const tyreChip = (compound, text = compound || "--") => `<span class="tyre-chip tyre-${tyreClass(compound)}"><i></i>${esc(text)}</span>`;
const colorFromStatus = (status) => statusColors[Number(status)] || "gray";

function driverLaps(car) {
  return (state.data?.laps || []).filter((lap) => Number(lap.driver_number) === Number(car));
}

function phaseNumber() {
  return state.activePhase ? Number(String(state.activePhase).replace(/^q/i, "")) : null;
}

function explicitQualifyingPhase(event) {
  const phase = Number(event?.qualifying_phase);
  return [1, 2, 3].includes(phase) ? phase : null;
}

function qualifyingPhaseWindows() {
  const events = (state.data?.race_control || [])
    .filter((event) => event.date)
    .map((event) => ({ ...event, time: Date.parse(event.date) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const windows = new Map();
  for (const phase of [1, 2, 3]) {
    const phaseEvents = events.filter((event) => explicitQualifyingPhase(event) === phase);
    const start = phaseEvents.find((event) => /SESSION STARTED/i.test(event.message || ""));
    if (!start) continue;
    const finish = phaseEvents.find((event) => event.time >= start.time && /SESSION FINISHED/i.test(event.message || ""))
      || phaseEvents.find((event) => event.time >= start.time && /CHEQUERED FLAG/i.test(event.message || ""));
    windows.set(phase, { start: start.time, end: finish?.time ?? null });
  }
  if (!windows.has(1)) {
    const q2Start = windows.get(2)?.start ?? null;
    const start = events.find((event) => explicitQualifyingPhase(event) == null && /SESSION STARTED/i.test(event.message || ""));
    const fallbackStart = Date.parse(state.data?.session?.date_start || "");
    const startTime = start?.time ?? (Number.isFinite(fallbackStart) ? fallbackStart : null);
    if (startTime != null) {
      const finish = events.find((event) => event.time >= startTime
        && (q2Start == null || event.time < q2Start)
        && (/SESSION FINISHED/i.test(event.message || "") || /CHEQUERED FLAG/i.test(event.message || "")));
      windows.set(1, { start: startTime, end: finish?.time ?? (q2Start == null ? null : q2Start - 1) });
    }
  }
  return windows;
}

function qualifyingPhaseForEvent(event, windows = qualifyingPhaseWindows()) {
  const explicit = explicitQualifyingPhase(event);
  if (explicit != null) return explicit;
  const messagePhase = String(event?.message || "").match(/\bS?Q([123])\b/i);
  if (messagePhase) return Number(messagePhase[1]);
  const time = Date.parse(event?.date || "");
  if (!Number.isFinite(time)) return null;
  for (const phase of [1, 2, 3]) {
    const window = windows.get(phase);
    if (window && time >= window.start && (window.end == null || time <= window.end)) return phase;
  }
  return null;
}

function currentPhaseLaps() {
  const laps = state.data?.laps || [];
  if (!state.activePhase) return laps;
  const window = qualifyingPhaseWindows().get(phaseNumber());
  if (!window) return [];
  return laps.filter((lap) => {
    const time = Date.parse(lap.date_start || "");
    return Number.isFinite(time) && time >= window.start && (window.end == null || time <= window.end);
  });
}

function driverLapsForView(car) {
  return currentPhaseLaps().filter((lap) => Number(lap.driver_number) === Number(car));
}

function computedSectorColors(car, lastLap, laps, sessionLaps = laps) {
  const valid = laps.filter((lap) => isCompleteLapRecord(lap) && !lap.is_pit_out_lap);
  const validSessionLaps = sessionLaps.filter((lap) => isCompleteLapRecord(lap) && !lap.is_pit_out_lap);
  const minimum = (rows, index) => {
    const values = rows.map((lap) => numeric(lap[`duration_sector_${index + 1}`])).filter((value) => value != null);
    return values.length ? Math.min(...values) : null;
  };
  const personalBest = [0, 1, 2].map((index) => minimum(valid, index));
  const overallBest = [0, 1, 2].map((index) => minimum(validSessionLaps, index));
  const values = lastLap ? [lastLap.duration_sector_1, lastLap.duration_sector_2, lastLap.duration_sector_3] : [];
  return [0, 1, 2].map((index) => {
    const value = numeric(values[index]);
    const personal = personalBest[index];
    const overall = overallBest[index];
    const currentColor = value == null ? null : value === overall ? "purple" : value === personal ? "green" : "yellow";
    const bestColor = personal == null ? null : personal === overall ? "purple" : "green";
    return { sector: index + 1, time: value == null ? "" : value.toFixed(3), time_color: currentColor, best_time: personal == null ? "" : personal.toFixed(3), best_time_color: bestColor };
  });
}

function computedMiniSectors(lastLap) {
  const arrays = lastLap ? [lastLap.segments_sector_1, lastLap.segments_sector_2, lastLap.segments_sector_3] : [[], [], []];
  return arrays.map((values, sectorIndex) => ({
    sector: sectorIndex + 1,
    mini_sectors: (values || []).filter((status) => status !== null && status !== undefined && status !== "" && Number.isFinite(Number(status))).map((status, miniIndex) => ({ mini_sector: miniIndex + 1, status: Number(status), color: colorFromStatus(status) })),
  }));
}

function extensionForRow(car, mapped, fastest) {
  const phaseMode = Boolean(state.activePhase);
  const viewLaps = driverLapsForView(car);
  const laps = viewLaps.filter(isCompleteLapRecord).sort((a, b) => a.lap_number - b.lap_number);
  const lastLap = laps.at(-1);
  const viewSessionLaps = currentPhaseLaps();
  const mappedExtra = phaseMode ? {} : (state.data?.mapped?.extra || {});
  const key = phaseMode || mapped?._id == null ? null : String(mapped._id);
  const sectors = key && mappedExtra.sectors?.[key] ? mappedExtra.sectors[key] : laps.length ? computedSectorColors(car, lastLap, laps, viewSessionLaps) : [];
  const mappedMiniSectors = key && (mappedExtra.mini_sectors?.[key] || mappedExtra.mini_sectors_data?.[key]);
  const hasMappedMiniSectors = Array.isArray(mappedMiniSectors) && mappedMiniSectors.some((sector) => (sector.mini_sectors || []).some((mini) => mini && mini.status !== null && mini.status !== undefined && mini.status !== "" && mini.color));
  const miniSectors = hasMappedMiniSectors ? mappedMiniSectors : lastLap ? computedMiniSectors(lastLap) : [];
  const stints = driverStints(car, viewLaps);
  const finalStint = stints.at(-1);
  const pits = driverPits(car, viewLaps).length;
  const phaseWindows = phaseMode ? qualifyingPhaseWindows() : null;
  const control = (state.data?.race_control || []).filter((message) => (Number(message.driver_number) === Number(car) || String(message.message || "").includes(`CAR ${car}`)) && (!phaseMode || qualifyingPhaseForEvent(message, phaseWindows) === phaseNumber()));
  const trackLimits = key && mappedExtra.track_limits?.[key] != null ? mappedExtra.track_limits[key] : control.filter((item) => /TRACK LIMITS/i.test(item.message || "")).length;
  const phaseFastest = laps.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0] || null;
  const effectiveFastest = phaseMode ? phaseFastest : fastest;
  const sessionLapTimes = viewSessionLaps.filter(isCompleteLapRecord).map((lap) => numeric(lap.lap_duration));
  const sessionFastest = sessionLapTimes.length ? Math.min(...sessionLapTimes) : null;
  const lastLapTime = key && mappedExtra.last_lap_time?.[key] ? mappedExtra.last_lap_time[key] : lastLap ? formatTime(lastLap.lap_duration) : null;
  const lastLapColor = key && mappedExtra.last_lap_time_color?.[key] ? mappedExtra.last_lap_time_color[key] : !lastLap ? null : lastLap.lap_duration === sessionFastest ? "purple" : lastLap === effectiveFastest ? "green" : "yellow";
  const bestLapColor = key && mappedExtra.best_lap_time_color?.[key] ? mappedExtra.best_lap_time_color[key] : !effectiveFastest ? null : effectiveFastest.lap_duration === sessionFastest ? "purple" : "green";
  const phaseLapCount = phaseMode ? laps.filter((lap) => !lap.is_pit_out_lap).length : null;
  return { lastLap, lastLapTime, lastLapColor, bestLapColor, sectors, miniSectors, stints, finalStint, pits, trackLimits, phaseLapCount, tyreInfo: key && mappedExtra.tire_info?.[key] ? mappedExtra.tire_info[key] : null, tyreHistory: key && mappedExtra.tire_history?.[key] ? mappedExtra.tire_history[key] : null };
}

function sectorSummary(sectors) {
  if (!Array.isArray(sectors) || !sectors.length) return "--";
  const row = (label, valueKey, colorKeyName) => {
    const values = sectors.map((sector) => {
      const value = sector[valueKey];
      return value ? `<span class="sector-chip"><b>S${esc(sector.sector)}</b> ${esc(value)} ${colorBadgeOrEmpty(sector[colorKeyName])}</span>` : "";
    }).filter(Boolean).join("");
    return values ? `<div class="sector-row"><span class="sector-row-label">${label}</span><div class="sector-row-values">${values}</div></div>` : "";
  };
  const rows = [row("上一圈", "time", "time_color"), row("个人最好", "best_time", "best_time_color")].filter(Boolean).join("");
  return rows ? `<div class="sector-summary">${rows}</div>` : "--";
}

function miniSectorSummary(miniSectors) {
  if (!Array.isArray(miniSectors) || !miniSectors.length) return "--";
  const groups = miniSectors.map((sector) => {
    const dots = (sector?.mini_sectors || [])
      .filter((mini) => mini && ((mini.status !== null && mini.status !== undefined && mini.status !== "") || (mini.color && mini.color !== "gray")) && mini.color)
      .map((mini) => '<i class="mini-dot color-' + colorKey(mini.color) + '" aria-hidden="true"></i>');
    return dots.length ? '<span class="mini-sector-group">' + dots.join("") + '</span>' : "";
  }).filter(Boolean);
  return groups.length ? '<div class="mini-sector-summary">' + groups.join("") + '</div>' : "--";
}

function ncContext(rawResults) {
  const enabled = ["Race", "Sprint"].includes(state.activeSession?.session_name);
  if (!enabled) return { enabled: false, winnerLaps: null, threshold: null };
  const winner = rawResults.find((row) => Number(row.position) === 1);
  const winnerLaps = winner?.number_of_laps == null ? null : Number(winner.number_of_laps);
  return Number.isFinite(winnerLaps)
    ? { enabled: true, winnerLaps, threshold: Math.floor(winnerLaps * 0.9) }
    : { enabled: false, winnerLaps: null, threshold: null };
}

function isNotClassified(raw, context) {
  if (!context.enabled || raw?.dns || raw?.dsq || raw?.number_of_laps == null) return false;
  const completedLaps = Number(raw.number_of_laps);
  return Number.isFinite(completedLaps) && completedLaps < context.threshold;
}

function resultOrder(row) {
  if (row.raw?.dsq) return 3;
  if (row.raw?.dns) return 2;
  if (row.isNc) return 1;
  return 0;
}

function getResultRows() {
  const data = state.data || {};
  const rawResults = data.session_result || [];
  const drivers = new Map((data.drivers || []).map((driver) => [Number(driver.driver_number), driver]));
  const mappedCompetitors = new Map((data.mapped?.competitors || []).map((row) => [Number(row.car_number), row]));
  const phaseIndex = state.activePhase === "q1" ? 0 : state.activePhase === "q2" ? 1 : state.activePhase === "q3" ? 2 : null;
  const classification = ncContext(rawResults);
  const viewLaps = currentPhaseLaps();
  const rows = rawResults.map((raw) => {
    const car = Number(raw.driver_number);
    const driver = drivers.get(car) || {};
    const mapped = mappedCompetitors.get(car) || {};
    const resultIndex = phaseIndex ?? (Array.isArray(raw.duration) ? 2 : null);
    const duration = resultIndex !== null && Array.isArray(raw.duration) ? (raw.duration[resultIndex] ?? null) : raw.duration;
    const gap = resultIndex !== null && Array.isArray(raw.gap_to_leader) ? (raw.gap_to_leader[resultIndex] ?? null) : raw.gap_to_leader;
    const fastest = viewLaps.filter((lap) => Number(lap.driver_number) === car && isCompleteLapRecord(lap)).sort((a, b) => a.lap_duration - b.lap_duration)[0] || null;
    return { raw, car, driver, mapped, duration, gap, fastest, classification, isNc: isNotClassified(raw, classification), extension: extensionForRow(car, mapped, fastest) };
  });
  if (state.activePhase) {
    rows.sort((a, b) => {
      const aTime = numeric(a.duration);
      const bTime = numeric(b.duration);
      const aMissing = aTime == null ? 1 : 0;
      const bMissing = bTime == null ? 1 : 0;
      return aMissing - bMissing || (aTime ?? Infinity) - (bTime ?? Infinity) || (a.raw.position ?? 999) - (b.raw.position ?? 999);
    });
    let phasePosition = 0;
    rows.forEach((row) => { row.displayPosition = numeric(row.duration) == null ? null : ++phasePosition; });
  } else {
    rows.sort((a, b) => resultOrder(a) - resultOrder(b) || (a.raw.position ?? 999) - (b.raw.position ?? 999));
  }
  return rows;
}

function displayTime(row) {
  if (state.activePhase) return row.duration == null ? "--" : formatTime(row.duration);
  if (isRaceSession() && Number(row.raw?.position) !== 1) {
    return displayGap(row.gap ?? row.mapped?.gap_to_leader);
  }
  if (row.mapped?.time?.value) return displayGap(row.mapped.time.value);
  if (row.duration == null) return displayGap(row.gap);
  return formatTime(row.duration);
}

function displayGap(value) {
  if (value == null || value === "") return "--";
  const text = String(value).trim();
  const laps = text.match(/^\+?\s*(\d+)\s*(?:LAPS?|L)$/i);
  if (laps) {
    const count = Number(laps[1]);
    return `+ ${count} ${count === 1 ? "lap" : "laps"}`;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) return text || "--";
  return amount === 0 ? "0" : `+${amount.toFixed(3)}`;
}

function finalIntervalMap() {
  const latest = new Map();
  for (const row of state.data?.intervals || []) {
    const car = Number(row.driver_number);
    if (!Number.isFinite(car)) continue;
    const previous = latest.get(car);
    if (!previous || Date.parse(row.date || "") >= Date.parse(previous.date || "")) latest.set(car, row);
  }
  return latest;
}

function intervalToPrevious(row, rowIndex, rows, intervalMap) {
  if (rowIndex === 0) return "--";
  const source = intervalMap.get(row.car)?.interval;
  if (numeric(source) != null) return displayGap(source);
  const currentGap = numeric(row.gap);
  const previousGap = numeric(rows[rowIndex - 1]?.gap);
  if (currentGap != null && previousGap != null) return displayGap(Math.max(0, currentGap - previousGap));
  const currentDuration = numeric(row.duration);
  const previousDuration = numeric(rows[rowIndex - 1]?.duration);
  return currentDuration != null && previousDuration != null
    ? displayGap(Math.max(0, currentDuration - previousDuration))
    : "--";
}

function gapToLeaderText(row) {
  const mappedGap = row.mapped?.gap_to_leader;
  return mappedGap !== null && mappedGap !== undefined && mappedGap !== "" ? displayGap(mappedGap) : displayGap(row.gap);
}

function renderResults() {
  const rows = getResultRows();
  const intervalMap = finalIntervalMap();
  renderResultHeader();
  const query = state.search.trim().toLowerCase();
  const filtered = rows.filter((row) => !query || [row.car, row.driver.full_name, row.driver.team_name, row.driver.name_acronym].some((value) => String(value ?? "").toLowerCase().includes(query)));
  const body = $("resultsTable").querySelector("tbody");
  if (!filtered.length) body.innerHTML = `<tr><td colspan="${resultColumnCount()}" class="empty-cell">没有匹配的车手</td></tr>`;
  else body.innerHTML = filtered.map((row) => {
    const status = statusLabel(row.raw);
    const displayPosition = state.activePhase ? (row.displayPosition ?? "--") : (row.raw.dsq ? "DSQ" : row.raw.dns ? "DNS" : row.isNc ? "NC" : (row.raw.position ?? "--"));
    const ncCell = row.isNc
      ? `<span class="nc-badge" title="完成 ${esc(row.raw.number_of_laps)} 圈，小于 NC 阈值 ${esc(row.classification.threshold)} 圈">NC</span>`
      : "--";
    const race = isRaceSession();
    const extension = row.extension;
    const currentTyre = extension.tyreInfo?.compound || extension.finalStint?.compound;
    const currentTyreLaps = extension.tyreInfo?.total_laps ?? (extension.finalStint ? extension.finalStint.lap_end - extension.finalStint.lap_start + 1 : null);
    const fastestText = !state.activePhase && row.mapped.fastest_lap_time ? row.mapped.fastest_lap_time : (row.fastest ? formatTime(row.fastest.lap_duration) : "--");
    const lapsText = state.activePhase ? (extension.phaseLapCount || "--") : (row.raw.number_of_laps ?? row.mapped.laps ?? "--");
    const colorText = miniSectorSummary(extension.miniSectors);
    const cells = {
      position: `<td class="position">${esc(displayPosition)}</td>`,
      car: `<td>${esc(row.car)}</td>`,
      driver: `<td class="driver-cell">${esc(row.driver.full_name || `车号 ${row.car}`)} <span class="acronym">${esc(row.driver.name_acronym || "")}</span></td>`,
      team: `<td>${esc(row.driver.team_name || "--")}</td>`,
      driverId: `<td>${esc(row.mapped._id ?? "--")}</td>`,
      teamId: `<td>${esc(row.mapped.teamuid ?? "--")}</td>`,
      laps: `<td>${esc(lapsText)}</td>`,
      time: `<td>${esc(displayTime(row))}</td>`,
      points: `<td>${esc(row.raw.points ?? row.mapped.points ?? "--")}</td>`,
      status: `<td class="${status === "Finished" ? "status-finished" : status === "无成绩" ? "status-missing" : "status-dnf"}">${esc(status)}</td>`,
      lastLap: `<td>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</td>`,
      fastestLap: `<td>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</td>`,
      interval: `<td>${esc(intervalToPrevious(row, rows.indexOf(row), rows, intervalMap))}</td>`,
      gap: `<td>${esc(gapToLeaderText(row))}</td>`,
      pit: `<td>${esc(row.mapped.pitstop_count ?? extension.pits ?? "--")}</td>`,
      nc: `<td>${ncCell}</td>`,
      tyre: `<td>${currentTyre ? tyreChip(currentTyre, `${currentTyre} · ${currentTyreLaps ?? "--"} 圈`) : "--"}</td>`,
      trackLimits: `<td>${esc(extension.trackLimits ?? "--")}</td>`,
      miniSectors: `<td><div class="row-colors">${colorText}</div></td>`,
      sectors: `<td>${sectorSummary(extension.sectors)}</td>`,
    };
    return `<tr data-car="${row.car}" class="${state.selectedDriver === row.car ? "selected" : ""}">${visibleResultColumns(false).map((column) => cells[column.key]).join("")}</tr>`;
  }).join("");
  body.querySelectorAll("tr[data-car]").forEach((tr) => tr.addEventListener("click", () => { state.selectedDriver = Number(tr.dataset.car); renderResults(); renderDriverDetails(); }));
  const classification = rows[0]?.classification;
  const ncSummary = classification?.enabled
    ? ` · NC 本地计算：冠军 ${classification.winnerLaps} 圈，90% 向下取整阈值 ${classification.threshold} 圈，${rows.filter((row) => row.isNc).length} 位 NC`
    : "";
  $("resultsFooter").textContent = `${filtered.length} / ${rows.length} 位车手 · 数据字段来自数据源${ncSummary} · 点击车手行查看车手详情`;
}

function driverStints(car, viewLaps = null) {
  const rows = (state.data?.stints || []).filter((row) => Number(row.driver_number) === Number(car)).sort((a, b) => a.stint_number - b.stint_number);
  if (!state.activePhase) return rows;
  const lapNumbers = new Set((viewLaps || []).map((lap) => Number(lap.lap_number)).filter(Number.isFinite));
  return rows.filter((row) => Array.from(lapNumbers).some((lap) => lap >= Number(row.lap_start) && lap <= Number(row.lap_end)));
}

function driverPits(car, viewLaps = null) {
  const rows = (state.data?.pit || []).filter((row) => Number(row.driver_number) === Number(car));
  if (!state.activePhase) return rows;
  const lapNumbers = new Set((viewLaps || []).map((lap) => Number(lap.lap_number)).filter(Number.isFinite));
  return rows.filter((row) => lapNumbers.has(Number(row.lap_number)));
}
function renderDriverDetails() {
  const car = state.selectedDriver;
  if (!car) return;
  const row = getResultRows().find((item) => item.car === car);
  if (!row) return;
  const extension = row.extension;
  const lastLap = extension.lastLap;
  const lastStint = extension.finalStint;
  const race = isRaceSession();
  const totalStintLaps = extension.stints.reduce((sum, stint) => sum + (Number(stint.lap_end) - Number(stint.lap_start) + 1), 0);
  const fastestText = state.activePhase ? (row.fastest ? formatTime(row.fastest.lap_duration) : "--") : (row.mapped.fastest_lap_time || (row.fastest ? formatTime(row.fastest.lap_duration) : "--"));
  $("driverDetails").innerHTML = `<div class="detail-content">${detailIdentityHtml({ driverId: row.mapped._id, teamId: row.mapped.teamuid, name: row.driver.full_name || `车号 ${car}`, car, team: row.driver.team_name })}<div class="detail-grid">
    <div class="detail-item"><label>上一圈</label><strong>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</strong></div>
    <div class="detail-item"><label>最快圈</label><strong>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</strong></div>
    <div class="detail-item"><label>当前轮胎</label><strong>${lastStint ? tyreChip(lastStint.compound, `${lastStint.compound} · L${lastStint.lap_start}-${lastStint.lap_end}`) : "--"}</strong></div>
    <div class="detail-item"><label>进站次数</label><strong>${row.mapped.pitstop_count ?? extension.pits ?? "--"}</strong></div>
    <div class="detail-item"><label>总圈数</label><strong>${totalStintLaps || "--"}</strong></div>
    <div class="detail-item"><label>超出赛道限制</label><strong>${extension.trackLimits ?? "--"}</strong></div>
    <div class="detail-item"><label>计时段</label><strong>${sectorSummary(extension.sectors)}</strong></div>
  </div><div class="detail-color-block"><label>小计时段</label>${miniSectorSummary(extension.miniSectors)}</div></div>`;
}

function renderWeather() {
  const phaseWindow = state.activePhase ? qualifyingPhaseWindows().get(phaseNumber()) : null;
  const weather = (state.data?.weather || []).filter((row) => {
    if (!phaseWindow) return !state.activePhase;
    const time = Date.parse(row.date || "");
    return Number.isFinite(time) && time >= phaseWindow.start && (phaseWindow.end == null || time <= phaseWindow.end);
  }).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = weather.at(-1);
  $("metricWeather").textContent = number(weather.length);
  $("weatherBadge").textContent = weather.length ? `${weather.length} 条` : "--";
  if (!latest) { $("weatherSnapshot").innerHTML = `<div class="empty-cell">暂无天气记录</div>`; return; }
  $("weatherSnapshot").innerHTML = [["气温", `${fixed(latest.air_temperature, 1)} °C`], ["赛道", `${fixed(latest.track_temperature, 1)} °C`], ["湿度", `${fixed(latest.humidity, 1)} %`], ["风速", `${fixed(latest.wind_speed, 1)} m/s`], ["风向", `${fixed(latest.wind_direction, 0)}°`]].map(([label, value]) => `<div class="weather-item"><label>${label}</label><strong>${esc(value)}</strong></div>`).join("");
  const limit = state.weatherView === "all" ? weather.length : Number(state.weatherView);
  const visible = weather.slice(Math.max(0, weather.length - limit)).reverse();
  $("weatherTable").querySelector("tbody").innerHTML = visible.map((row) => `<tr><td>${esc(dateText(row.date))}</td><td>${esc(fixed(row.air_temperature, 1))} °C</td><td>${esc(fixed(row.track_temperature, 1))} °C</td><td>${esc(fixed(row.humidity, 1))} %</td><td>${esc(fixed(row.pressure, 1))} hPa</td><td>${esc(fixed(row.wind_speed, 1))} m/s</td><td>${esc(fixed(row.wind_direction, 0))}°</td><td>${row.rainfall ? "是" : "否"}</td></tr>`).join("");
}

function renderTyres() {
  const stints = (state.data?.stints || []).filter((stint) => {
    if (!state.activePhase) return true;
    const viewLaps = driverLapsForView(stint.driver_number);
    const start = Number(stint.lap_start);
    const end = Number(stint.lap_end);
    return Number.isFinite(start) && Number.isFinite(end) && viewLaps.some((lap) => Number(lap.lap_number) >= start && Number(lap.lap_number) <= end);
  }).slice().sort((a, b) => Number(a.driver_number) - Number(b.driver_number) || Number(a.stint_number) - Number(b.stint_number));
  const grouped = new Map();
  for (const stint of stints) {
    const car = Number(stint.driver_number);
    if (!grouped.has(car)) grouped.set(car, []);
    grouped.get(car).push(stint);
  }
  const totalPitStops = Array.from(grouped.keys()).reduce((sum, car) => sum + driverPits(car, state.activePhase ? driverLapsForView(car) : null).length, 0);
  $("tyreBadge").textContent = `${grouped.size} 位车手 · ${totalPitStops} 次进站`;
  if (!grouped.size) return;
  const drivers = new Map((state.data?.drivers || []).map((driver) => [Number(driver.driver_number), driver]));
  $("tyreTable").querySelector("tbody").innerHTML = Array.from(grouped.entries()).map(([car, rows]) => {
    const last = rows.at(-1);
    const totalLaps = rows.reduce((sum, row) => sum + (Number(row.lap_end) - Number(row.lap_start) + 1), 0);
    const strategy = rows.map((row) => `<span class="tyre-strategy-item">${tyreChip(row.compound, row.compound || "--")} <span>L${esc(row.lap_start)}-${esc(row.lap_end)}</span></span>`).join(`<span class="strategy-arrow" aria-hidden="true">→</span>`);
    const pitStops = driverPits(car, state.activePhase ? driverLapsForView(car) : null).length;
    return `<tr><td>${esc(drivers.get(car)?.full_name || `车号 ${car}`)} <span class="acronym">${esc(drivers.get(car)?.name_acronym || "")}</span></td><td>${esc(car)}</td><td class="wrap-cell tyre-strategy">${strategy}</td><td>${esc(pitStops)}</td><td>${esc(totalLaps)}</td><td>${last ? tyreChip(last.compound, last.compound) : "--"}</td></tr>`;
  }).join("");
}

function renderMessages() {
  const phase = phaseNumber();
  const phaseWindows = phase == null ? null : qualifyingPhaseWindows();
  const messages = (state.data?.race_control || []).filter((message) => phase == null || qualifyingPhaseForEvent(message, phaseWindows) === phase).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  $("metricMessages").textContent = number(messages.length);
  $("messageBadge").textContent = `${messages.length} 条`;
  if (!messages.length) return;
  const limit = state.messageView === "all" ? messages.length : Number(state.messageView);
  const visible = messages.slice(Math.max(0, messages.length - limit)).reverse();
  const language = state.messageLanguage || "both";
  $("messageTable").querySelector("tbody").innerHTML = visible.map((row) => {
    const { english, chinese } = raceControlMessageParts(row);
    const messageHtml = language === "en"
      ? `<div class="message-line message-line-en">${esc(english)}</div>`
      : language === "zh"
        ? `<div class="message-line message-line-zh">${esc(chinese)}</div>`
        : `<div class="message-lines"><div class="message-line message-line-en">${esc(english)}</div><div class="message-line message-line-zh">${esc(chinese)}</div></div>`;
    return `<tr><td>${esc(dateText(row.date || row.utc))}</td><td>${esc(row.lap_number ?? row.lap ?? "--")}</td><td class="wrap-cell">${messageHtml}</td></tr>`;
  }).join("");
}

async function loadCurrentData() {
  const requestId = ++state.dataRequestId;
  const meetingKey = state.activeMeeting?.meeting_key;
  const sessionKey = state.activeSession?.session_key;
  if (!state.activeSession) { resetDataPanels(); return; }
  setStatus("正在同步数据", `${sessionLabel(state.activeSession.session_name)} · ${sessionKey}`, true);
  resetDataPanels("正在从本地缓存或数据源获取数据…");
  if (sessionKey == null) {
    const message = "该节点已写入 Meeting 目录，数据源尚未返回 session_key；接口可用后重新选择分站即可自动补齐。";
    resetDataPanels(message);
    if (requestId !== state.dataRequestId) return;
    setStatus("等待数据源会话键", `Meeting ${meetingKey ?? "--"} · ${sessionLabel(state.activeSession.session_name)}`, false);
    $("cachePathLabel").textContent = "缓存状态：尚未获取";
    return;
  }
  try {
    const payload = await api(`/api/session-data?meeting_key=${meetingKey}&session_key=${sessionKey}`);
    if (requestId !== state.dataRequestId || meetingKey !== state.activeMeeting?.meeting_key || sessionKey !== state.activeSession?.session_key) return;
    state.data = enrichBackendMapping(payload.data || {});
    state.selectedDriver = null;
    const sourceLabel = payload.source === "cache" ? "本地缓存" : payload.source === "local" ? "本地快照" : "数据源刚刚拉取并已缓存";
    setStatus("数据已就绪", `${sourceLabel} · ${state.data.session?.date_start ? dateText(state.data.session.date_start) : ""}${syncTimestampText(state.data)}${syncWarningText(state.data.sync_warnings)}`, false);
    $("cachePathLabel").textContent = `缓存状态：${sourceLabel}`;
    $("metricDrivers").textContent = number((state.data.session_result || []).length);
    const metricLaps = currentPhaseLaps();
    $("metricLaps").textContent = number(Math.max(0, ...metricLaps.map((lap) => Number(lap.lap_number) || 0)));
    renderResults(); renderWeather(); renderTyres(); renderMessages();
  } catch (error) {
    if (requestId !== state.dataRequestId || meetingKey !== state.activeMeeting?.meeting_key || sessionKey !== state.activeSession?.session_key) return;
    state.data = null;
    resetDataPanels(error.message || "暂无数据");
    setStatus("数据同步失败", "请检查本地服务或稍后重试", false);
    $("cachePathLabel").textContent = "缓存状态：未获取";
  }
}

$("meetingSelect").addEventListener("change", async (event) => {
  state.activeMeeting = state.meetings.find((meeting) => String(meeting.meeting_key) === event.target.value) || null;
  await loadSessions(state.activeMeeting?.meeting_key);
});
$("seasonSelect").addEventListener("change", async (event) => {
  state.season = Number(event.target.value) || state.seasons[0] || 2026;
  await loadMeetings();
});
$("sessionSelect").addEventListener("change", (event) => selectSessionNode(event.target.value));
$("refreshBtn").addEventListener("click", loadCurrentData);
$("syncBtn").addEventListener("click", async () => {
  const meetingKey = state.activeMeeting?.meeting_key;
  const sessionKey = state.activeSession?.session_key;
  const button = $("syncBtn");
  if (meetingKey == null || sessionKey == null || button.disabled) return;
  const requestId = ++state.dataRequestId;
  button.disabled = true;
  button.innerHTML = "↻ <span>同步中…</span>";
  setStatus("正在同步数据", `${sessionLabel(state.activeSession.session_name)} · ${sessionKey}`, true);
  try {
    const payload = await api("/api/sync-session-data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_key: meetingKey, session_key: sessionKey }) });
    if (requestId !== state.dataRequestId || meetingKey !== state.activeMeeting?.meeting_key || sessionKey !== state.activeSession?.session_key) return;
    state.data = enrichBackendMapping(payload.data || {});
    state.selectedDriver = null;
    const sourceLabel = "数据源已同步并更新缓存";
    setStatus(syncTitle(state.data), `${sourceLabel} · ${state.data.session?.date_start ? dateText(state.data.session.date_start) : ""}${syncTimestampText(state.data)}${syncWarningText(state.data.sync_warnings)}`, false);
    $("cachePathLabel").textContent = `缓存状态：${sourceLabel}`;
    $("metricDrivers").textContent = number((state.data.session_result || []).length);
    const metricLaps = currentPhaseLaps();
    $("metricLaps").textContent = number(Math.max(0, ...metricLaps.map((lap) => Number(lap.lap_number) || 0)));
    renderResults(); renderWeather(); renderTyres(); renderMessages();
  } catch (error) {
    if (requestId !== state.dataRequestId || meetingKey !== state.activeMeeting?.meeting_key || sessionKey !== state.activeSession?.session_key) return;
    setStatus("同步失败", "缓存未更新，当前数据仍保持不变", false);
    $("cachePathLabel").textContent = `缓存状态：未更新 · ${error.message || "请稍后重试"}`;
  } finally {
    button.disabled = false;
    button.innerHTML = "↻ <span>同步数据源</span>";
  }
});
$("logoutBtn").addEventListener("click", async () => {
  if (STATIC_MODE) {
    window.localStorage.removeItem("f1-static-auth");
    window.location.replace("./login.html");
    return;
  }
  await fetch("/api/logout", { method: "POST" });
  window.location.replace("/login");
});
$("driverSearch").addEventListener("input", (event) => { state.search = event.target.value; renderResults(); });
$("clearSearch").addEventListener("click", () => { $("driverSearch").value = ""; state.search = ""; renderResults(); });
$("weatherView").addEventListener("change", (event) => { state.weatherView = event.target.value; renderWeather(); });
$("messageView").addEventListener("change", (event) => { state.messageView = event.target.value; renderMessages(); });
$("messageLanguage").addEventListener("change", (event) => { state.messageLanguage = event.target.value; renderMessages(); });
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
document.querySelectorAll("[data-standings-kind]").forEach((button) => button.addEventListener("click", () => {
  state.standingsKind = button.dataset.standingsKind === "teams" ? "teams" : "drivers";
  renderStandings();
}));
$("standingsSyncBtn")?.addEventListener("click", () => loadOfficialStandings({ force: true }));
$("standingsSeasonSelect")?.addEventListener("change", async (event) => {
  state.standingsSeason = standingsSeasons.includes(Number(event.target.value)) ? Number(event.target.value) : CURRENT_STANDINGS_SEASON;
  state.standings = null;
  state.standingsError = null;
  renderStandings();
  await loadOfficialStandings();
});
$("liveSeasonSelect")?.addEventListener("change", async (event) => {
  state.season = Number(event.target.value) || state.seasons[0] || 2026;
  await loadMeetings();
  renderLiveTimingSelectors();
});
$("liveMeetingSelect")?.addEventListener("change", async (event) => {
  stopLivePolling();
  resetLiveTiming();
  await loadLiveTimingSessions(event.target.value);
});
$("liveSessionSelect")?.addEventListener("change", (event) => {
  stopLivePolling();
  const session = state.liveTiming.sessions.find((item) => String(item.session_key) === event.target.value);
  state.liveTiming.sessionKey = session?.session_key ?? null;
  state.liveTiming.sessionName = session?.session_name || "Race";
  resetLiveTiming();
  renderLiveTimingSelectors();
});
$("liveSourceSelect")?.addEventListener("change", (event) => {
  const source = event.target.value === "nana" ? "nana" : "f1telemetry";
  if (source === state.liveTiming.source) return;
  state.liveTiming.source = source;
  resetLiveTiming();
  renderLiveTiming();
});
$("liveLoadBtn")?.addEventListener("click", () => {
  if (state.liveTiming.running) {
    stopLivePolling();
    renderLiveTiming();
  } else {
    startLivePolling();
  }
});
$("liveSyncBtn")?.addEventListener("click", () => loadLiveTimingData());
$("liveDriverSearch")?.addEventListener("input", (event) => { state.liveTiming.search = event.target.value; renderLiveTiming(); });
$("liveClearSearch")?.addEventListener("click", () => { $("liveDriverSearch").value = ""; state.liveTiming.search = ""; renderLiveTiming(); });
$("liveWeatherView")?.addEventListener("change", (event) => { state.liveTiming.weatherView = event.target.value; renderLiveWeather(); });
$("liveMessageView")?.addEventListener("change", (event) => { state.liveTiming.messageView = event.target.value; renderLiveTiming(); });
$("liveMessageLanguage")?.addEventListener("change", (event) => { state.liveTiming.messageLanguage = event.target.value; renderLiveTiming(); });
bindResultColumnPicker("resultColumnPicker", "resultColumnPickerReset");
bindResultColumnPicker("liveColumnPicker", "liveColumnPickerReset");
document.addEventListener("click", (event) => {
  if (event.target.closest(".column-picker")) return;
  document.querySelectorAll(".column-picker-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.closest(".column-picker")?.querySelector("[data-column-picker-toggle]")?.setAttribute("aria-expanded", "false");
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".column-picker-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.closest(".column-picker")?.querySelector("[data-column-picker-toggle]")?.setAttribute("aria-expanded", "false");
  });
});

resetLiveTiming();
resetDataPanels();
initialiseScheduleCatalog();
