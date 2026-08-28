import {
  mapOpenF1ToBackend,
  resolveBackendDriverId as sharedResolveBackendDriverId,
  resolveBackendTeamId as sharedResolveBackendTeamId,
} from "./backend-fields.mjs";
import { openF1TelemetryStream } from "./f1telemetry.mjs";

const state = {
  season: 2026,
  meetings: [],
  sessions: [],
  activeMeeting: null,
  activeSession: null,
  activePhase: null,
  data: null,
  standings: null,
  standingsError: null,
  standingsKind: "drivers",
  activeView: "schedule",
  selectedDriver: null,
  search: "",
  weatherView: "all",
  messageView: "all",
  messageLanguage: "both",
  dataRequestId: 0,
  liveTiming: {
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
const STATIC_MODE = new URLSearchParams(window.location.search).get("static") === "1"
  || (!localServer && !window.location.pathname.startsWith("/site/"));
const STATIC_API_BASE = "https://api.openf1.org/v1";
const STATIC_CACHE_VERSION = "20260828-backend-fields-v2";
const staticRequestTimeoutMs = 30000;
const staticRequestIntervalMs = 400;
let staticNextRequestAt = 0;
const STATIC_CATALOG_URL = new URL("./meetings-2026.json", import.meta.url).href;
const STATIC_MAPPED_URL = new URL("./netherlands-race-mapped.json", import.meta.url).href;
const STATIC_STANDINGS_URL = new URL(
  window.location.pathname.startsWith("/site/") ? "../official-standings-2026.json" : "./official-standings-2026.json",
  import.meta.url,
).href;
const staticDb = { promise: null };
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
      data[field] = rows;
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
        values[key] = await staticFetchJson(endpointFactory(sessionKey));
      } catch (error) {
        if (error.status === 404) { values[key] = []; unavailable.push(key); }
        else if (Array.isArray(cached?.[key])) { values[key] = cached[key]; retained.push(`${key}: ${error.message}`); }
        else if (requiredFields.has(key)) failures.push(`${key}: ${error.message}`);
        else { values[key] = []; retained.push(`${key}: ${error.message}`); }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, definitions.length) }, () => worker()));
  return { values, failures, unavailable, retained };
}

async function staticCatalog() {
  const response = await fetch(STATIC_CATALOG_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`赛季目录读取失败 ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.meetings;
  return (Array.isArray(rows) ? rows : []).map((meeting) => ({
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

function stripRaceControlTranslations(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data.race_control)) {
    data.race_control = data.race_control.map((row) => {
      if (!row || typeof row !== "object") return row;
      const { text_zh, ...withoutTranslation } = row;
      return withoutTranslation;
    });
  }
  if (data.mapped && typeof data.mapped === "object" && Array.isArray(data.mapped.messages)) {
    data.mapped.messages = data.mapped.messages.map((row) => {
      if (!row || typeof row !== "object") return row;
      const { text_zh, ...withoutTranslation } = row;
      return withoutTranslation;
    });
  }
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
  stripRaceControlTranslations(data);
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
    const sanitised = stripStartingGridFields(stripIgnoredSyncWarnings(stripTyreAgeFields(cached)));
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
    ...row,
    backend_driver_id: resolveBackendDriverId({ name_acronym: row.code, full_name: row.name }),
    backend_team_id: sharedResolveBackendTeamId(row.team),
  }));
  const teams = (Array.isArray(snapshot.teams) ? snapshot.teams : []).map((row) => ({
    ...row,
    backend_team_id: sharedResolveBackendTeamId(row.name),
  }));
  return { ...snapshot, drivers, teams };
}

async function staticStandings({ force = false } = {}) {
  const cacheKey = `${STATIC_CACHE_VERSION}:official-standings:${state.season}`;
  const cached = await staticCacheGet(cacheKey);
  try {
    const response = await fetch(STATIC_STANDINGS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`年度排名快照读取失败 ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.drivers) || !Array.isArray(data.teams)) throw new Error("年度排名快照格式不完整");
    await staticCacheSet(cacheKey, data);
    return { data, source: "official" };
  } catch (error) {
    if (cached && Number(cached.season) === Number(state.season)) return { data: cached, source: "cache", error: error.message };
    throw error;
  }
}

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[char]));
const number = (value, fallback = "--") => value === null || value === undefined || value === "" ? fallback : Number(value).toLocaleString("en-US");
const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const fixed = (value, digits = 3) => numeric(value) == null ? "--" : numeric(value).toFixed(digits);
const dateText = (value) => value ? String(value).replace("T", " ").replace("+00:00", " UTC").replace("Z", " UTC") : "--";
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
const statusLabel = (row) => row?.dsq ? "DSQ" : row?.dns ? "DNS" : row?.dnf ? "DNF" : "Finished";
const raceSessionNames = new Set(["Race", "Sprint"]);
const qualifyingSessionNames = new Set(["Qualifying", "Sprint Qualifying"]);
const colorNames = { purple: "紫", green: "绿", yellow: "黄", red: "红", blue: "蓝", gray: "灰" };
const colorKey = (value) => colorNames[String(value || "gray").toLowerCase()] ? String(value).toLowerCase() : "gray";
const colorBadge = (value, prefix = "") => `<span class="color-badge color-${colorKey(value)}" title="${esc(value || "gray")}">${esc(prefix)}${colorNames[colorKey(value)]}</span>`;
const colorBadgeOrEmpty = (value, prefix = "") => value == null || value === "" ? "" : colorBadge(value, prefix);
const phaseLabel = (phase) => phase ? phase.toUpperCase() : "";
const isRaceSession = () => raceSessionNames.has(state.activeSession?.session_name);
const isQualifyingSession = () => qualifyingSessionNames.has(state.activeSession?.session_name);
const resultColumnCount = () => isRaceSession() ? 20 : 18;
const formatTime = (value) => {
  const total = numeric(value);
  if (total == null) return "--";
  if (total >= 3600) return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${(total % 60).toFixed(3).padStart(6, "0")}`;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(3).padStart(6, "0")}`;
};

async function api(path, options = {}) {
  if (STATIC_MODE) {
    const url = new URL(path, window.location.href);
    if (url.pathname === "/api/meetings") return { data: await staticCatalog(), source: "catalog" };
    if (url.pathname === "/api/sessions") return staticSessionList(url.searchParams.get("meeting_key"));
    if (url.pathname === "/api/live-session-data") return staticLiveSessionSnapshot(url.searchParams.get("meeting_key"), url.searchParams.get("session_key"));
    if (url.pathname === "/api/session-data") return staticSessionSnapshot(url.searchParams.get("meeting_key"), url.searchParams.get("session_key"));
    if (url.pathname === "/api/sync-session-data") {
      const body = JSON.parse(options.body || "{}");
      return staticSessionSnapshot(body.meeting_key, body.session_key, { force: true });
    }
    if (url.pathname === "/api/standings") return staticStandings();
    if (url.pathname === "/api/sync-standings") return staticStandings({ force: true });
    return { authenticated: true, username: "nana" };
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
      ? `<tr><td class="position">${esc(row.position ?? "--")}</td><td class="driver-cell">${esc(row.name || "--")}</td><td>${esc(row.backend_team_id ?? "--")}</td><td>${esc(row.points ?? "--")}</td></tr>`
      : `<tr><td class="position">${esc(row.position ?? "--")}</td><td class="driver-cell">${esc(row.name || "--")}</td><td><span class="acronym">${esc(row.code || "--")}</span></td><td>${esc(row.nationality || "--")}</td><td>${esc(row.team || "--")}</td><td>${esc(row.backend_driver_id ?? "--")}</td><td>${esc(row.backend_team_id ?? "--")}</td><td>${esc(row.points ?? "--")}</td></tr>`).join("")
    : `<tr><td colspan="${kind === "teams" ? 4 : 8}" class="empty-cell">${snapshot ? "暂无年度排名数据" : "点击加载年度排名"}</td></tr>`;
  $("standingsCapturedAt").textContent = snapshot?.captured_at ? `官网快照：${dateText(snapshot.captured_at)}` : "官网快照：--";
  $("standingsCount").textContent = snapshot ? `${rows.length} 条` : "--";
  $("standingsSource").textContent = snapshot ? "数据源：官网排名快照" : "数据源：--";
  const alert = $("standingsAlert");
  const syncStatus = snapshot?.sync_status;
  const failed = syncStatus?.status === "failed" || Boolean(state.standingsError);
  if (alert) {
    if (failed) {
      const attemptedAt = syncStatus?.attempted_at ? `（尝试时间：${dateText(syncStatus.attempted_at)}）` : "";
      const detail = syncStatus?.error || state.standingsError || "官网排名自动同步失败，请查看同步日志";
      const detailSuffix = /自动同步失败/.test(detail) ? "" : ` ${detail}`;
      alert.textContent = snapshot
        ? `年度排名自动同步失败${attemptedAt}。当前显示上次成功的排名快照。${detailSuffix}`
        : `年度排名自动同步失败。${detail}`;
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
  const button = $("standingsSyncBtn");
  const status = $("standingsStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = force ? "正在刷新官网快照…" : "正在读取官网快照…";
  try {
    const payload = await api(force ? "/api/sync-standings" : "/api/standings", force ? { method: "POST" } : {});
    state.standings = enrichOfficialStandings(payload.data);
    state.standingsError = null;
    renderStandings();
    if (status) status.textContent = payload.data?.sync_status?.status === "failed"
      ? "自动同步失败，显示上次成功快照"
      : payload.source === "cache" || payload.source === "local" ? "已读取本地快照" : "排名快照已更新";
  } catch (error) {
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
  const country = meeting.country_name || "";
  const title = country === "Netherlands" ? "荷兰大奖赛" : meeting.meeting_name || country || "实时推送";
  const sessionName = session.session_name || live.sessionName;
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

function buildLiveRows(data) {
  const drivers = new Map((data?.drivers || []).map((driver) => [Number(driver.driver_number), driver]));
  const results = new Map((data?.session_result || []).map((result) => [Number(result.driver_number), result]));
  const mappedRows = new Map((data?.mapped?.competitors || []).map((row) => [Number(row.car_number), row]));
  const mappedExtra = data?.mapped?.extra || {};
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
    const status = result.dsq ? "DSQ" : result.dns ? "DNS" : result.dnf ? "DNF" : recentPit ? "进站" : data?.session?.date_end && Date.parse(data.session.date_end) < snapshotTime ? "完成" : "运行中";
    const mappedId = mapped.id ?? resolveBackendDriverId(driver);
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
    const name = driver.full_name || `${driver.first_name || ""} ${driver.last_name || ""}`.trim() || `车手 ${car}`;
    return {
      position: resultPosition ?? livePosition ?? null,
      car,
      name,
      code: driver.name_acronym || "",
      team: driver.team_name || "--",
      driverId: mappedId,
      teamId: mapped.team_id ?? sharedResolveBackendTeamId(driver.team_name),
      lap: mapped.laps ?? numeric(result.number_of_laps) ?? numeric(latestLap.lap_number),
      lastLap: mappedLastLap || result.last_lap_duration || latestLap.lap_duration,
      bestLap: mappedBestLap || result.best_lap_duration || bestLap?.lap_duration || null,
      gap,
      interval: intervalValue,
      points: result.points ?? mapped.points ?? null,
      status,
      pitCount: mapped.pitstop ?? pit?.count ?? 0,
      mapped,
      extra: mappedId != null ? {
        lastLapColor: mappedExtra.last_lap_time_color?.[String(mappedId)] || null,
        bestLapColor: mappedExtra.best_lap_time_color?.[String(mappedId)] || null,
        sectors: mappedExtra.sectors?.[String(mappedId)] || directSectors,
        miniSectors: mappedExtra.mini_sectors_data?.[String(mappedId)] || directMiniSectors,
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
  return (Array.isArray(data?.race_control) ? data.race_control : [])
    .slice()
    .sort((a, b) => (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0))
    .map((row, index) => {
      const { english, chinese } = raceControlMessageParts(row);
      return { sequence: index + 1, receivedAt: row.date, lap: row.lap_number ?? row.lap ?? "--", typeLabel: row.category || "赛会消息", english, chinese, message: english };
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
const liveResultColumnCount = () => liveIsRaceSession() ? 20 : 18;
const liveResultHeaderHtml = () => {
  const race = liveIsRaceSession();
  return `<tr><th>名次</th><th>车号</th><th>车手</th><th>车队</th><th>后台车手ID</th><th>后台车队ID</th><th>圈数</th><th>总时间 / 差距</th>${race ? "<th>积分</th>" : ""}<th>状态</th><th>上一圈</th><th>最快圈</th><th>与上一名间距</th><th>与第一名间距</th><th>进站</th>${race ? "<th>NC（计算）</th>" : ""}<th>当前轮胎</th><th>超出赛道限制</th><th>小计时段</th><th>计时段</th></tr>`;
};

function renderLiveTiming() {
  const live = state.liveTiming;
  const table = $("liveTimingTable");
  if (!table) return;
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
      return `<tr data-live-car="${esc(row.car)}" class="${live.selectedDriver === row.car ? "selected" : ""}">
        <td class="position">${esc(row.position ?? "--")}</td><td>${esc(row.car)}</td><td class="driver-cell"><strong>${esc(row.name)}</strong><span class="driver-code">${esc(row.code)}</span></td><td>${esc(row.team)}</td><td>${esc(row.driverId ?? "--")}</td><td>${esc(row.teamId ?? "--")}</td><td>${esc(row.lap ?? "--")}</td>
        <td>${esc(rowIndex === 0 && row.duration != null ? formatTime(row.duration) : displayGap(row.gap))}</td>${race ? `<td>${esc(row.points ?? "--")}</td>` : ""}<td><span class="live-row-status ${statusClass}">${esc(row.status)}</span></td>
        <td>${displayLapTime(row.lastLap)} ${colorBadgeOrEmpty(row.extra?.lastLapColor)}</td><td>${displayLapTime(row.bestLap)} ${colorBadgeOrEmpty(row.extra?.bestLapColor)}</td>
        <td>${esc(previousGap)}</td><td>${esc(displayGap(row.gap))}</td><td>${esc(row.pitCount ?? "--")}</td>${race ? "<td>--</td>" : ""}
        <td>${currentTyre ? tyreChip(currentTyre, `${currentTyre} · ${currentTyreLaps ?? "--"} 圈`) : "--"}</td><td>${esc(row.extra?.trackLimits ?? "--")}</td>
        <td><div class="row-colors">${miniSectorSummary(row.extra?.miniSectors)}</div></td><td>${sectorSummary(row.extra?.sectors)}</td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="${liveResultColumnCount()}" class="empty-cell">${live.rows.length ? "没有匹配的车手" : "点击开始推送"}</td></tr>`;
  table.querySelectorAll("tr[data-live-car]").forEach((tr) => tr.addEventListener("click", () => {
    live.selectedDriver = Number(tr.dataset.liveCar);
    renderLiveTiming();
  }));
  const data = live.data || {};
  $("liveMetricDrivers").textContent = number((data.drivers || []).length);
  $("liveMetricLaps").textContent = number(Math.max(0, ...(data.laps || []).map((lap) => Number(lap.lap_number) || 0)));
  $("liveMetricWeather").textContent = number((data.weather || []).length);
  $("liveMetricMessages").textContent = number((data.race_control || []).length);
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
  $("liveStatusTitle").textContent = live.loading ? "正在更新" : live.running ? "实时更新中" : live.received ? "已停止" : "等待加载";
  $("liveStatusPulse").classList.toggle("connected", live.running);
  $("liveStatusMeta").textContent = live.lastAt ? `最后更新 ${liveClock(live.lastAt)} · WebSocket 持续连接${live.errors ? ` · ${live.errors} 个字段失败` : ""}` : "尚未接收到消息";
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
  container.innerHTML = `<div class="detail-content"><div class="detail-name"><strong>${esc(row.name)}</strong><span>#${esc(row.car)} · ${esc(row.team)}</span></div><div class="detail-grid">
    <div class="detail-item"><label>上一圈</label><strong>${displayLapTime(row.lastLap)} ${colorBadgeOrEmpty(extension.lastLapColor)}</strong></div>
    <div class="detail-item"><label>最快圈</label><strong>${displayLapTime(row.bestLap)} ${colorBadgeOrEmpty(extension.bestLapColor)}</strong></div>
    <div class="detail-item"><label>当前轮胎</label><strong>${tyre ? tyreChip(tyre.compound, `${tyre.compound} · ${tyreLaps} 圈`) : "--"}</strong></div>
    <div class="detail-item"><label>进站次数</label><strong>${esc(row.pitCount ?? "--")}</strong></div>
    <div class="detail-item"><label>总圈数</label><strong>${esc(row.lap ?? "--")}</strong></div>
    <div class="detail-item"><label>超出赛道限制</label><strong>${esc(extension.trackLimits ?? "--")}</strong></div>
    <div class="detail-item"><label>轮胎历史圈数</label><strong>${esc(historyLaps || "--")}</strong></div>
    <div class="detail-item"><label>计时段</label><strong>${sectorSummary(extension.sectors)}</strong></div>
  </div><div class="detail-color-block"><label>Mini-sector 颜色</label>${miniSectorSummary(extension.miniSectors)}</div></div>`;
}

function renderLiveWeather() {
  const data = state.liveTiming.data || {};
  const weather = (data.weather || []).slice().sort((a, b) => (Date.parse(a.date || "") || 0) - (Date.parse(b.date || "") || 0));
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
  const data = state.liveTiming.data || {};
  const drivers = new Map((data.drivers || []).map((driver) => [Number(driver.driver_number), driver]));
  const pitCounts = (data.pit || []).reduce((map, pit) => map.set(Number(pit.driver_number), (map.get(Number(pit.driver_number)) || 0) + 1), new Map());
  const grouped = new Map();
  for (const stint of data.stints || []) {
    const car = Number(stint.driver_number);
    if (!Number.isFinite(car)) continue;
    if (!grouped.has(car)) grouped.set(car, []);
    grouped.get(car).push(stint);
  }
  const liveRows = new Map(state.liveTiming.rows.map((row) => [row.car, row]));
  const rows = Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
  $("liveTyreBadge").textContent = rows.length ? `${rows.length} 位车手` : "--";
  table.querySelector("tbody").innerHTML = rows.length
    ? rows.map(([car, stints]) => {
      stints.sort((a, b) => Number(a.stint_number) - Number(b.stint_number));
      const strategy = stints.map((stint) => `<span class="tyre-strategy-item">${tyreChip(stint.compound, stint.compound || "--")} <span>L${esc(stint.lap_start ?? "--")}-${esc(stint.lap_end ?? "--")}</span></span>`).join(`<span class="strategy-arrow" aria-hidden="true">→</span>`);
      const last = stints.at(-1);
      const totalLaps = stints.reduce((sum, stint) => sum + (Number(stint.total_laps) || 0), 0);
      const liveTyre = liveRows.get(car)?.extra?.tyreInfo || last;
      return `<tr><td>${esc(drivers.get(car)?.full_name || `车号 ${car}`)} <span class="acronym">${esc(drivers.get(car)?.name_acronym || "")}</span></td><td>${esc(car)}</td><td class="wrap-cell tyre-strategy">${strategy}</td><td>${esc(pitCounts.get(car) || 0)}</td><td>${esc(totalLaps || "--")}</td><td>${liveTyre ? tyreChip(liveTyre.compound, liveTyre.compound) : "--"}</td></tr>`;
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
  setConnection(false, "正在连接实时接口");
  renderLiveTiming();
  try {
    live.stream = openF1TelemetryStream({
      requestedMeetingKey: null,
      requestedSessionKey: null,
      timeoutMs: 30000,
      onState: (data) => {
        if (token !== live.token || state.activeView !== "liveTiming") return;
        live.data = enrichBackendMapping(data || {});
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
        setConnection(false, "实时接口已断开");
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
  state.activeView = ["schedule", "standings", "liveTiming"].includes(view) ? view : "schedule";
  $("scheduleView").hidden = state.activeView !== "schedule";
  $("standingsView").hidden = state.activeView !== "standings";
  $("liveTimingView").hidden = state.activeView !== "liveTiming";
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
  const phase = phaseLabel(state.activePhase);
  const suffix = phase ? `（${phase}）` : "";
  const race = isRaceSession();
  return `<tr><th>名次</th><th>车号</th><th>车手</th><th>车队</th><th>后台车手ID</th><th>后台车队ID</th><th>圈数</th><th id="resultTimeHeader">${phase ? `${phase} 总时间 / 差距` : "总时间 / 差距"}</th>${race ? "<th>积分</th>" : ""}<th>状态</th><th id="resultLastLapHeader">上一圈${suffix}</th><th id="resultFastestHeader">最快圈${suffix}</th><th>与上一名间距</th><th id="resultGapHeader">与第一名间距</th><th>进站</th>${race ? "<th>NC（计算）</th>" : ""}<th>当前轮胎</th><th>超出赛道限制</th><th>小计时段</th><th>计时段</th></tr>`;
}

function renderResultHeader() {
  $("resultsTable").querySelector("thead").innerHTML = resultHeaderHtml();
}

function resetDataPanels(message = "选择节点后加载数据") {
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
  select.innerHTML = state.meetings.map((meeting) => {
    const testing = meeting.meeting_name === "Pre-Season Testing";
    const label = testing ? `${meeting.meeting_name} · ${meeting.location || meeting.country_name || ""}` : (meeting.meeting_name || meeting.country_name || "未命名分站");
    const round = meeting.round ? `第 ${meeting.round} 站 · ` : "测试 · ";
    const cancelled = meeting.is_cancelled ? " · 已取消" : "";
    return `<option value="${esc(meeting.meeting_key)}">${esc(round + label + cancelled)}</option>`;
  }).join("");
  if (state.activeMeeting) select.value = String(state.activeMeeting.meeting_key);
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
  select.innerHTML = nodes.map((node) => `<option value="${esc(node.key)}">${esc(node.label)}${node.session.is_catalog_placeholder ? " · 待获取" : ""}</option>`).join("");
  const activeNode = nodes.find((node) => node.session === state.activeSession && node.phase === state.activePhase);
  const activeKey = activeNode?.key || nodes[0]?.key;
  if (activeKey) select.value = activeKey;
  $("sessionTabs").innerHTML = nodes.map((node) => `<button class="session-tab${node.phase ? " phase" : ""}${node.key === activeKey ? " active" : ""}" data-session-node="${esc(node.key)}">${esc(node.label)}</button>`).join("");
  $("sessionTabs").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectSessionNode(button.dataset.sessionNode)));
}

function setMeetingMeta(meeting, session) {
  const name = meeting?.country_name === "Netherlands" ? "荷兰大奖赛" : (meeting?.meeting_name || meeting?.country_name || "分站");
  $("pageTitle").textContent = name === "Netherlands" ? "荷兰大奖赛" : name;
  const phase = state.activePhase ? ` · ${phaseLabel(state.activePhase)}` : "";
  $("pageSubtitle").textContent = `${meeting?.country_name || ""}${meeting?.location ? ` · ${meeting.location}` : ""} · ${session ? sessionLabel(session.session_name) : "选择一个会话节点"}${phase}`;
  $("meetingKeyLabel").textContent = meeting?.meeting_key ?? "--";
  $("sessionKeyLabel").textContent = session?.session_key ?? "--";
}

async function loadMeetings() {
  $("seasonSelect").innerHTML = `<option value="2026">2026</option>`;
  try {
    const payload = await api(`/api/meetings?year=${state.season}`);
    state.meetings = (payload.data || []).slice().sort((a, b) => (a.round ?? 999) - (b.round ?? 999) || Date.parse(a.date_start || 0) - Date.parse(b.date_start || 0));
    setConnection(payload.source === "openf1" || payload.source === "cache", payload.source === "openf1" ? "数据源已连接" : payload.source === "catalog" ? "本地赛季目录" : "本地缓存");
  } catch (error) {
    state.meetings = [];
    setConnection(false, "离线演示数据");
    setStatus("无法读取分站列表", "请检查本地目录文件", false);
  }
  state.activeMeeting = state.meetings.find((meeting) => Number(meeting.meeting_key) === 1292) || state.meetings[0];
  renderMeetings();
  renderLiveTimingSelectors();
  await loadSessions(state.activeMeeting?.meeting_key);
}

async function loadSessions(meetingKey) {
  if (!meetingKey) return;
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

function qualifyingPhaseWindows() {
  const events = (state.data?.race_control || [])
    .filter((event) => [1, 2, 3].includes(Number(event.qualifying_phase)) && event.date)
    .map((event) => ({ ...event, time: Date.parse(event.date) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const windows = new Map();
  for (const phase of [1, 2, 3]) {
    const phaseEvents = events.filter((event) => Number(event.qualifying_phase) === phase);
    const start = phaseEvents.find((event) => /SESSION STARTED/i.test(event.message || ""));
    if (!start) continue;
    const finish = phaseEvents.find((event) => event.time >= start.time && /SESSION FINISHED/i.test(event.message || ""))
      || phaseEvents.find((event) => event.time >= start.time && /CHEQUERED FLAG/i.test(event.message || ""));
    windows.set(phase, { start: start.time, end: finish?.time ?? null });
  }
  return windows;
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
  const valid = laps.filter((lap) => lap.lap_duration != null && !lap.is_pit_out_lap);
  const validSessionLaps = sessionLaps.filter((lap) => lap.lap_duration != null && !lap.is_pit_out_lap);
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
  const laps = viewLaps.filter((lap) => lap.lap_duration != null).sort((a, b) => a.lap_number - b.lap_number);
  const lastLap = laps.at(-1);
  const viewSessionLaps = currentPhaseLaps();
  const mappedExtra = phaseMode ? {} : (state.data?.mapped?.extra || {});
  const key = phaseMode || mapped?.id == null ? null : String(mapped.id);
  const sectors = key && mappedExtra.sectors?.[key] ? mappedExtra.sectors[key] : laps.length ? computedSectorColors(car, lastLap, laps, viewSessionLaps) : [];
  const mappedMiniSectors = key && (mappedExtra.mini_sectors?.[key] || mappedExtra.mini_sectors_data?.[key]);
  const hasMappedMiniSectors = Array.isArray(mappedMiniSectors) && mappedMiniSectors.some((sector) => (sector.mini_sectors || []).some((mini) => mini && mini.status !== null && mini.status !== undefined && mini.status !== "" && mini.color));
  const miniSectors = hasMappedMiniSectors ? mappedMiniSectors : lastLap ? computedMiniSectors(lastLap) : [];
  const stints = driverStints(car, viewLaps);
  const finalStint = stints.at(-1);
  const pits = driverPits(car, viewLaps).length;
  const control = (state.data?.race_control || []).filter((message) => (Number(message.driver_number) === Number(car) || String(message.message || "").includes(`CAR ${car}`)) && (!phaseMode || Number(message.qualifying_phase) === phaseNumber()));
  const trackLimits = key && mappedExtra.track_limits?.[key] != null ? mappedExtra.track_limits[key] : control.filter((item) => /TRACK LIMITS/i.test(item.message || "")).length;
  const phaseFastest = laps.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0] || null;
  const effectiveFastest = phaseMode ? phaseFastest : fastest;
  const sessionLapTimes = viewSessionLaps.map((lap) => numeric(lap.lap_duration)).filter((value) => value != null);
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
  const dots = miniSectors.flatMap((sector) => (sector.mini_sectors || []).filter((mini) => mini && ((mini.status !== null && mini.status !== undefined && mini.status !== "") || (mini.color && mini.color !== "gray")) && mini.color).map((mini) => `<i class="mini-dot color-${colorKey(mini.color)}" aria-hidden="true"></i>`));
  return dots.length ? `<div class="mini-sector-summary">${dots.join("")}</div>` : "--";
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
    const fastest = viewLaps.filter((lap) => Number(lap.driver_number) === car && lap.lap_duration != null).sort((a, b) => a.lap_duration - b.lap_duration)[0] || null;
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
    return `<tr data-car="${row.car}" class="${state.selectedDriver === row.car ? "selected" : ""}">
      <td class="position">${esc(displayPosition)}</td><td>${esc(row.car)}</td>
      <td class="driver-cell">${esc(row.driver.full_name || `车号 ${row.car}`)} <span class="acronym">${esc(row.driver.name_acronym || "")}</span></td>
      <td>${esc(row.driver.team_name || "--")}</td><td>${esc(row.mapped.id ?? "--")}</td><td>${esc(row.mapped.team_id ?? "--")}</td>
      <td>${esc(lapsText)}</td>
      <td>${esc(displayTime(row))}</td>${race ? `<td>${esc(row.raw.points ?? row.mapped.points ?? "--")}</td>` : ""}
      <td class="${status === "Finished" ? "status-finished" : "status-dnf"}">${esc(status)}</td>
      <td>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</td><td>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</td>
      <td>${esc(intervalToPrevious(row, rows.indexOf(row), rows, intervalMap))}</td><td>${esc(gapToLeaderText(row))}</td>
      <td>${esc(row.mapped.pitstop ?? extension.pits ?? "--")}</td>${race ? `<td>${ncCell}</td>` : ""}
      <td>${currentTyre ? tyreChip(currentTyre, `${currentTyre} · ${currentTyreLaps ?? "--"} 圈`) : "--"}</td><td>${esc(extension.trackLimits ?? "--")}</td>
      <td><div class="row-colors">${colorText}</div></td>
      <td>${sectorSummary(extension.sectors)}</td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-car]").forEach((tr) => tr.addEventListener("click", () => { state.selectedDriver = Number(tr.dataset.car); renderResults(); renderDriverDetails(); }));
  const classification = rows[0]?.classification;
  const ncSummary = classification?.enabled
    ? ` · NC 本地计算：冠军 ${classification.winnerLaps} 圈，90% 向下取整阈值 ${classification.threshold} 圈，${rows.filter((row) => row.isNc).length} 位 NC`
    : "";
  $("resultsFooter").textContent = `${filtered.length} / ${rows.length} 位车手 · 数据字段来自数据源${ncSummary} · 点击车手行查看扩展字段`;
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
  $("driverDetails").innerHTML = `<div class="detail-content"><div class="detail-name"><strong>${esc(row.driver.full_name || `车号 ${car}`)}</strong><span>#${esc(car)} · ${esc(row.driver.team_name || "--")}</span></div><div class="detail-grid">
    <div class="detail-item"><label>上一圈</label><strong>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</strong></div>
    <div class="detail-item"><label>最快圈</label><strong>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</strong></div>
    <div class="detail-item"><label>当前轮胎</label><strong>${lastStint ? tyreChip(lastStint.compound, `${lastStint.compound} · L${lastStint.lap_start}-${lastStint.lap_end}`) : "--"}</strong></div>
    <div class="detail-item"><label>进站次数</label><strong>${row.mapped.pitstop ?? extension.pits ?? "--"}</strong></div>
    <div class="detail-item"><label>总圈数</label><strong>${totalStintLaps || "--"}</strong></div>
    <div class="detail-item"><label>超出赛道限制</label><strong>${extension.trackLimits ?? "--"}</strong></div>
    <div class="detail-item"><label>计时段</label><strong>${sectorSummary(extension.sectors)}</strong></div>
  </div><div class="detail-color-block"><label>Mini-sector 颜色</label>${miniSectorSummary(extension.miniSectors)}</div></div>`;
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
  const messages = (state.data?.race_control || []).filter((message) => phase == null || Number(message.qualifying_phase) === phase).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
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
  setStatus("正在加载数据", `${sessionLabel(state.activeSession.session_name)} · ${sessionKey}`, true);
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
    setStatus("数据加载失败", "请检查本地服务或稍后重试", false);
    $("cachePathLabel").textContent = "缓存状态：未获取";
  }
}

$("meetingSelect").addEventListener("change", async (event) => {
  state.activeMeeting = state.meetings.find((meeting) => String(meeting.meeting_key) === event.target.value) || null;
  await loadSessions(state.activeMeeting?.meeting_key);
});
$("sessionSelect").addEventListener("change", (event) => selectSessionNode(event.target.value));
$("loadBtn").addEventListener("click", loadCurrentData);
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
$("liveSeasonSelect")?.addEventListener("change", async (event) => {
  state.season = Number(event.target.value) || 2026;
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

resetLiveTiming();
resetDataPanels();
loadMeetings();
