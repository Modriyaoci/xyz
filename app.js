const state = {
  season: 2026,
  meetings: [],
  sessions: [],
  activeMeeting: null,
  activeSession: null,
  activePhase: null,
  data: null,
  standings: null,
  standingsKind: "drivers",
  activeView: "schedule",
  selectedDriver: null,
  search: "",
  weatherView: "all",
  messageView: "all",
  dataRequestId: 0,
};

// GitHub Pages cannot run the Node proxy. In that deployment the browser talks
// to OpenF1 directly and keeps complete session snapshots in IndexedDB.
const localServer = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const STATIC_MODE = new URLSearchParams(window.location.search).get("static") === "1"
  || (!localServer && !window.location.pathname.startsWith("/site/"));
const STATIC_API_BASE = "https://api.openf1.org/v1";
const staticRequestTimeoutMs = 15000;
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), staticRequestTimeoutMs);
    let response;
    try {
      response = await fetch(`${STATIC_API_BASE}${endpoint}`, { headers: { accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (attempt < 1) { await staticSleep(1000); continue; }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    if (response.ok) return response.json();
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await staticSleep(Math.max(1500, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0) * (attempt + 1));
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
  if (!sessionEnded || !Array.isArray(data[field]) || data[field].length) return;
  const key = Number(sessionKey);
  const probeKey = `${field}:${key}`;
  const now = Date.now();
  if (now - (staticFeedProbeAt.get(probeKey) || 0) < staticFeedProbeIntervalMs) return;
  staticFeedProbeAt.set(probeKey, now);
  try {
    const rows = await staticFetchJson(`/${field}?session_key=${encodeURIComponent(key)}`);
    if (Array.isArray(rows) && rows.length) data[field] = rows;
  } catch { /* retain the existing cache when the data source is unavailable */ }
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

// Backend IDs are stable across the 2026 season; OpenF1 supplies the matching
// driver acronym/name and team name for every session.
const backendDriverIdByAcronym = new Map(Object.entries({
  ALB: 347504, LIN: 347549, SAI: 347548, LEC: 347492, OCO: 347547, ALO: 347502,
  COL: 347540, BOR: 347539, RUS: 347501, HAD: 347537, ANT: 347534, STR: 347503,
  NOR: 347506, HAM: 347542, LAW: 347514, VER: 347482, HUL: 347544, BEA: 347520,
  PIA: 347528, GAS: 347499, PER: 347519, BOT: 347525, CRA: 347908, FOR: 368438,
  HER: 368439, IWA: 347538, BEG: 347535, BRO: 347536, VES: 347526, ARO: 347526,
  HIR: 347541, TSU: 347546,
}));
const backendDriverIdByName = new Map(Object.entries({
  "alexander albon": 347504, "arvid lindblad": 347549, "carlos sainz": 347548,
  "charles leclerc": 347492, "esteban ocon": 347547, "fernando alonso": 347502,
  "franco colapinto": 347540, "gabriel bortoleto": 347539, "george russell": 347501,
  "isack hadjar": 347537, "kimi antonelli": 347534, "lance stroll": 347503,
  "lando norris": 347506, "lewis hamilton": 347542, "liam lawson": 347514,
  "max verstappen": 347482, "nico hulkenberg": 347544, "oliver bearman": 347520,
  "oscar piastri": 347528, "pierre gasly": 347499, "sergio perez": 347519,
  "valtteri bottas": 347525, "jak crawford": 347908, "leonardo fornaroli": 368438,
  "colton herta": 368439, "ayumu iwasa": 347538, "dino beganovic": 347535,
  "luke browning": 347536, "frederik vesti": 347526, "paul aron": 347526,
  "ryo hirakawa": 347541, "yuki tsunoda": 347546,
}));
const backendDriverIdByCar = new Map([
  [1, 347506], [3, 347482], [5, 347539], [10, 347499], [11, 347519], [12, 347534],
  [14, 347502], [16, 347492], [18, 347503], [22, 347546], [23, 347504], [27, 347544],
  [30, 347514], [31, 347547], [41, 347549], [43, 347540], [44, 347542], [55, 347548],
  [63, 347501], [77, 347525], [81, 347528], [87, 347520],
]);
const backendTeamIdByName = new Map(Object.entries({
  alpine: 385366, "aston martin": 385362, audi: 394048, cadillac: 390378,
  ferrari: 385364, "haas f1 team": 385361, mclaren: 385367, mercedes: 385358,
  "racing bulls": 385363, "red bull racing": 385355, williams: 385365,
}));
const identityKey = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

function lookupIdentity(map, value) {
  const key = identityKey(value);
  if (!key) return null;
  if (map.has(key)) return Number(map.get(key));
  for (const [alias, id] of map) if (key.endsWith(` ${alias}`) || alias.endsWith(` ${key}`)) return Number(id);
  return null;
}

function resolveBackendDriverId(driver) {
  const acronym = String(driver?.name_acronym || "").trim().toUpperCase();
  if (backendDriverIdByAcronym.has(acronym)) return Number(backendDriverIdByAcronym.get(acronym));
  const name = lookupIdentity(backendDriverIdByName, driver?.full_name)
    ?? lookupIdentity(backendDriverIdByName, `${driver?.first_name || ""} ${driver?.last_name || ""}`);
  return name ?? backendDriverIdByCar.get(Number(driver?.driver_number)) ?? null;
}

function enrichBackendMapping(data) {
  if (!data || typeof data !== "object") return data;
  const drivers = Array.isArray(data.drivers) ? data.drivers : [];
  const mapped = data.mapped && typeof data.mapped === "object" ? data.mapped : {};
  const competitors = Array.isArray(mapped.competitors) ? mapped.competitors.slice() : [];
  const byCar = new Map(competitors.map((row) => [Number(row.car_number), row]));
  for (const driver of drivers) {
    const car = Number(driver?.driver_number);
    if (!Number.isFinite(car)) continue;
    const id = resolveBackendDriverId(driver);
    const teamId = lookupIdentity(backendTeamIdByName, driver?.team_name);
    if (id == null && teamId == null) continue;
    const row = byCar.get(car) || { car_number: car };
    if (!byCar.has(car)) { byCar.set(car, row); competitors.push(row); }
    if (id != null) row.id = id;
    if (teamId != null) row.team_id = teamId;
  }
  data.mapped = { ...mapped, competitors };
  return data;
}

async function staticSessionList(meetingKey) {
  const key = Number(meetingKey);
  const catalog = await staticCatalog();
  const meeting = catalog.find((item) => Number(item.meeting_key) === key);
  if (!meeting) throw new Error("找不到对应分站");
  if (meeting.sessions.length) return { data: meeting.sessions, source: "catalog" };
  const cacheKey = `sessions:${key}`;
  const cached = await staticCacheGet(cacheKey);
  if (Array.isArray(cached) && cached.length) return { data: cached, source: "cache" };
  const data = await staticFetchJson(`/sessions?meeting_key=${encodeURIComponent(key)}`);
  await staticCacheSet(cacheKey, data);
  return { data, source: "openf1" };
}

async function staticSessionSnapshot(meetingKey, sessionKey, { force = false } = {}) {
  const requestedSessionKey = Number(sessionKey);
  if (!Number.isInteger(requestedSessionKey)) throw new Error("该节点尚未获得数据源会话键");
  const cacheKey = `session:${requestedSessionKey}`;
  const cached = await staticCacheGet(cacheKey);
  if (!force && cached && Number(cached.session?.session_key) === requestedSessionKey) {
    const sanitised = stripTyreAgeFields(cached);
    await refreshStaticCachedFeed(sanitised, requestedSessionKey, "weather");
    if (["Race", "Sprint"].includes(sanitised.session?.session_name)) await refreshStaticCachedFeed(sanitised, requestedSessionKey, "pit");
    await refreshStaticCachedFeed(sanitised, requestedSessionKey, "race_control");
    enrichBackendMapping(sanitised);
    await staticCacheSet(cacheKey, sanitised);
    return { data: sanitised, source: "cache" };
  }
  const sessionsPayload = await staticSessionList(meetingKey);
  const session = (sessionsPayload.data || []).find((item) => Number(item.session_key) === requestedSessionKey);
  if (!session) throw new Error("找不到对应数据源会话");
  const endpoints = [
    ["drivers", `/drivers?session_key=${requestedSessionKey}`], ["session_result", `/session_result?session_key=${requestedSessionKey}`], ["starting_grid", `/starting_grid?session_key=${requestedSessionKey}`],
    ["laps", `/laps?session_key=${requestedSessionKey}`], ["pit", `/pit?session_key=${requestedSessionKey}`], ["position", `/position?session_key=${requestedSessionKey}`], ["intervals", `/intervals?session_key=${requestedSessionKey}`],
    ["stints", `/stints?session_key=${requestedSessionKey}`], ["race_control", `/race_control?session_key=${requestedSessionKey}`], ["weather", `/weather?session_key=${requestedSessionKey}`],
  ];
  const data = { meeting: { meeting_key: Number(meetingKey), country_name: session.country_name, location: session.location, meeting_name: session.meeting_name || session.country_name }, session, mapped: null };
  const unavailable = [];
  const retained = [];
  const requiredFields = new Set(["drivers", "session_result"]);
  for (const [key, endpoint] of endpoints) {
    await staticSleep(750);
    try { data[key] = await staticFetchJson(endpoint); }
    catch (error) {
      if (error.status === 404) { data[key] = []; unavailable.push(key); }
      else if (Array.isArray(cached?.[key])) { data[key] = cached[key]; retained.push(`${key}: ${error.message}`); }
      else if (requiredFields.has(key)) throw new Error(`同步失败，缺少必要数据（${key}: ${error.message}）`);
      else { data[key] = []; retained.push(`${key}: ${error.message}`); }
    }
  }
  if (Number(meetingKey) === 1292 && requestedSessionKey === 11353) {
    try {
      const mappedResponse = await fetch(STATIC_MAPPED_URL, { cache: "no-store" });
      if (mappedResponse.ok) data.mapped = await mappedResponse.json();
    } catch { /* the data source remains usable without the optional mapping */ }
  }
  const syncWarnings = [...unavailable.map((field) => `${field}: unavailable`), ...retained];
  if (syncWarnings.length) data.sync_warnings = syncWarnings;
  stripTyreAgeFields(data);
  enrichBackendMapping(data);
  await staticCacheSet(cacheKey, data);
  return { data, source: "openf1" };
}

function enrichOfficialStandings(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const drivers = (Array.isArray(snapshot.drivers) ? snapshot.drivers : []).map((row) => ({
    ...row,
    backend_driver_id: resolveBackendDriverId({ name_acronym: row.code, full_name: row.name }),
    backend_team_id: lookupIdentity(backendTeamIdByName, row.team),
  }));
  const teams = (Array.isArray(snapshot.teams) ? snapshot.teams : []).map((row) => ({
    ...row,
    backend_team_id: lookupIdentity(backendTeamIdByName, row.name),
  }));
  return { ...snapshot, drivers, teams };
}

async function staticStandings({ force = false } = {}) {
  const cacheKey = `official-standings:${state.season}`;
  if (!force) {
    const cached = await staticCacheGet(cacheKey);
    if (cached && Number(cached.season) === Number(state.season)) return { data: cached, source: "cache" };
  }
  const response = await fetch(STATIC_STANDINGS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`年度排名快照读取失败 ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.drivers) || !Array.isArray(data.teams)) throw new Error("年度排名快照格式不完整");
  await staticCacheSet(cacheKey, data);
  return { data, source: "official" };
}

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[char]));
const number = (value, fallback = "--") => value === null || value === undefined || value === "" ? fallback : Number(value).toLocaleString("en-US");
const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const fixed = (value, digits = 3) => numeric(value) == null ? "--" : numeric(value).toFixed(digits);
const dateText = (value) => value ? String(value).replace("T", " ").replace("+00:00", " UTC").replace("Z", " UTC") : "--";
const syncWarningText = (warnings) => {
  if (!Array.isArray(warnings) || !warnings.length) return "";
  const labels = { drivers: "车手", session_result: "赛果", starting_grid: "发车位", laps: "圈次", pit: "进站", position: "位置", intervals: "间隔", stints: "轮胎", race_control: "赛会消息", weather: "天气" };
  const fields = [...new Set(warnings.map((warning) => String(warning).split(":")[0]).map((field) => labels[field] || field))];
  return fields.length ? ` · 部分字段未更新：${fields.join("、")}` : "";
};
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
const resultColumnCount = () => isRaceSession() ? 22 : 18;
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
    renderStandings();
    if (status) status.textContent = payload.source === "cache" || payload.source === "local" ? "已读取本地快照" : "排名快照已更新";
  } catch (error) {
    if (status) status.textContent = error.message || "年度排名读取失败";
    if (!state.standings) renderStandings();
  } finally {
    if (button) button.disabled = false;
  }
}

function setActiveView(view) {
  state.activeView = view === "standings" ? "standings" : "schedule";
  $("scheduleView").hidden = state.activeView !== "schedule";
  $("standingsView").hidden = state.activeView !== "standings";
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.activeView));
  if (state.activeView === "standings" && !state.standings) loadOfficialStandings();
}

function resultHeaderHtml() {
  const phase = phaseLabel(state.activePhase);
  const suffix = phase ? `（${phase}）` : "";
  const race = isRaceSession();
  return `<tr><th>名次</th><th>车号</th><th>车手</th><th>车队</th><th>后台车手ID</th><th>后台车队ID</th>${race ? "<th>发车位</th>" : ""}<th>圈数</th><th id="resultTimeHeader">${phase ? `${phase} 总时间 / 差距` : "总时间 / 差距"}</th>${race ? "<th>积分</th>" : ""}<th>状态</th><th id="resultLastLapHeader">上一圈${suffix}</th><th id="resultFastestHeader">最快圈${suffix}</th><th>与上一名间距</th><th id="resultGapHeader">与第一名间距</th><th>进站</th>${race ? "<th>领跑圈</th><th>NC（计算）</th>" : ""}<th>当前轮胎</th><th>赛道限制</th><th>小计时段</th><th>计时段</th></tr>`;
}

function renderResultHeader() {
  $("resultsTable").querySelector("thead").innerHTML = resultHeaderHtml();
}

function resetDataPanels(message = "选择节点后加载数据") {
  ["metricDrivers", "metricLaps", "metricWeather", "metricMessages"].forEach((id) => $(id).textContent = "--");
  renderResultHeader();
  $("resultsTable").querySelector("tbody").innerHTML = `<tr><td colspan="${resultColumnCount()}" class="empty-cell">${esc(message)}</td></tr>`;
  $("resultsFooter").textContent = message;
  $("driverDetails").innerHTML = `<span class="placeholder-icon">＋</span><span>点击上方赛果中的车手行</span><small>查看最后一圈、计时段、轮胎和赛道限制</small>`;
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
      ${race ? `<td>${esc(row.mapped.grid ?? "--")}</td>` : ""}<td>${esc(lapsText)}</td>
      <td>${esc(displayTime(row))}</td>${race ? `<td>${esc(row.raw.points ?? row.mapped.points ?? "--")}</td>` : ""}
      <td class="${status === "Finished" ? "status-finished" : "status-dnf"}">${esc(status)}</td>
      <td>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</td><td>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</td>
      <td>${esc(intervalToPrevious(row, rows.indexOf(row), rows, intervalMap))}</td><td>${esc(gapToLeaderText(row))}</td>
      <td>${esc(row.mapped.pitstop ?? extension.pits ?? "--")}</td>${race ? `<td>${esc(row.mapped.laps_led ?? "--")}</td><td>${ncCell}</td>` : ""}
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
  const fastestText = state.activePhase ? (row.fastest ? formatTime(row.fastest.lap_duration) : "--") : (row.mapped.fastest_lap_time || (row.fastest ? formatTime(row.fastest.lap_duration) : "--"));
  $("driverDetails").innerHTML = `<div class="detail-content"><div class="detail-name"><strong>${esc(row.driver.full_name || `车号 ${car}`)}</strong><span>#${esc(car)} · ${esc(row.driver.team_name || "--")}</span></div><div class="detail-grid">
    <div class="detail-item"><label>最后一圈</label><strong>${esc(extension.lastLapTime || "--")} ${colorBadgeOrEmpty(extension.lastLapColor)}</strong></div>
    <div class="detail-item"><label>最快圈</label><strong>${esc(fastestText)} ${colorBadgeOrEmpty(extension.bestLapColor)}</strong></div>
    <div class="detail-item"><label>当前轮胎</label><strong>${lastStint ? tyreChip(lastStint.compound, `${lastStint.compound} · L${lastStint.lap_start}-${lastStint.lap_end}`) : "--"}</strong></div>
    <div class="detail-item"><label>进站次数 / 总圈数</label><strong>${row.mapped.pitstop ?? extension.pits ?? "--"} / ${extension.stints.reduce((sum, stint) => sum + (Number(stint.lap_end) - Number(stint.lap_start) + 1), 0) || "--"}</strong></div>
    ${race ? `<div class="detail-item"><label>领跑圈数</label><strong>${row.mapped.laps_led ?? "--"}</strong></div>` : ""}
    <div class="detail-item"><label>赛道限制消息</label><strong>${extension.trackLimits ?? "--"}</strong></div>
    <div class="detail-item"><label>最后一圈计时段</label><strong>${sectorSummary(extension.sectors)}</strong></div>
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
  $("messageTable").querySelector("tbody").innerHTML = visible.map((row) => `<tr><td>${esc(dateText(row.date))}</td><td>${esc(row.lap_number ?? "--")}</td><td class="wrap-cell">${esc(row.message || "--")}</td></tr>`).join("");
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
    setStatus("数据已就绪", `${sourceLabel} · ${state.data.session?.date_start ? dateText(state.data.session.date_start) : ""}${syncWarningText(state.data.sync_warnings)}`, false);
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
    setStatus("同步完成", `${sourceLabel} · ${state.data.session?.date_start ? dateText(state.data.session.date_start) : ""}${syncWarningText(state.data.sync_warnings)}`, false);
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
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
document.querySelectorAll("[data-standings-kind]").forEach((button) => button.addEventListener("click", () => {
  state.standingsKind = button.dataset.standingsKind === "teams" ? "teams" : "drivers";
  renderStandings();
}));
$("standingsSyncBtn")?.addEventListener("click", () => loadOfficialStandings({ force: true }));

resetDataPanels();
loadMeetings();
