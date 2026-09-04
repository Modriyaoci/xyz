import { decode } from "@msgpack/msgpack";
import { readFileSync } from "node:fs";
import { normaliseNanaSnapshot } from "./nana-mapping.mjs";

export const NAMI_PROVIDERS = Object.freeze({
  radar: Object.freeze({ key: "radar", pid: 84, label: "雷达" }),
  dash: Object.freeze({ key: "dash", pid: 138, label: "dash" }),
  official: Object.freeze({ key: "official", pid: 139, label: "官方" }),
});

const NAMI_HISTORY_PID = 103;

const rawCatalog = JSON.parse(readFileSync(new URL("./nami-catalog.json", import.meta.url), "utf8"));

const baseSessionName = (name) => String(name || "").replace(/ Q[123]$/i, "");
const sessionType = (name) => {
  const base = baseSessionName(name);
  if (base === "Race" || base === "Sprint") return "Race";
  if (base === "Qualifying" || base === "Sprint Qualifying") return "Qualifying";
  return "Practice";
};

export const NAMI_MEETINGS = Object.freeze(rawCatalog.meetings.map((meeting) => Object.freeze({
  meeting_key: meeting.meeting_key,
  season_id: rawCatalog.season_id,
  meeting_name: meeting.meeting_name,
  country_name: meeting.country_name,
  country_code: meeting.country_code,
  location: meeting.location,
  circuit_short_name: meeting.circuit_short_name,
  round: meeting.round,
  year: rawCatalog.season,
  date_start: meeting.date_start,
  date_end: meeting.date_end,
})));

export const NAMI_STAGE_LIST = Object.freeze(rawCatalog.meetings.flatMap((meeting) => (
  meeting.stages.map(([stageId, name]) => {
    const phase = String(name).match(/ Q([123])$/i)?.[1] || null;
    const window = meeting.windows[baseSessionName(name)] || [meeting.date_start, meeting.date_end];
    return Object.freeze({
      stage_id: stageId,
      meeting_key: meeting.meeting_key,
      season_id: rawCatalog.season_id,
      season: rawCatalog.season,
      round: meeting.round,
      meeting_name: meeting.meeting_name,
      country_name: meeting.country_name,
      country_code: meeting.country_code,
      location: meeting.location,
      circuit_short_name: meeting.circuit_short_name,
      session_name: name,
      session_type: sessionType(name),
      session_phase: phase ? `q${phase}` : null,
      date_start: window[0],
      date_end: window[1],
    });
  })
)));

export const NAMI_STAGES = Object.freeze(Object.fromEntries(NAMI_STAGE_LIST.map((stage) => [String(stage.stage_id), stage])));

const NAMI_AUTO_STAGE_LIST = Object.freeze(NAMI_STAGE_LIST
  .filter((stage) => !stage.session_phase)
  .slice()
  .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start)));
const DEFAULT_AUTO_LEAD_MS = 15 * 60 * 1000;
const DEFAULT_AUTO_GRACE_MS = 45 * 60 * 1000;

const text = (value) => value === null || value === undefined ? "" : String(value).trim();
const numeric = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export function namiProvider(value) {
  return NAMI_PROVIDERS[String(value || "").trim().toLowerCase()] || null;
}

export function namiStage(value) {
  return NAMI_STAGES[String(Number(value))] || null;
}

export function namiMeetingRows(year = 2026) {
  return NAMI_MEETINGS.filter((meeting) => Number(meeting.year) === Number(year)).map((meeting) => ({ ...meeting }));
}

export function namiSessionRows(meetingKey) {
  const stages = NAMI_STAGE_LIST.filter((stage) => Number(stage.meeting_key) === Number(meetingKey));
  return stages.map((stage) => ({
    session_key: stage.stage_id,
    stage_id: stage.stage_id,
    meeting_key: stage.meeting_key,
    session_name: stage.session_name,
    session_type: stage.session_type,
    session_phase: stage.session_phase,
    node_label: stage.session_name,
    date_start: stage.date_start,
    date_end: stage.date_end,
    year: stage.season,
    season_id: stage.season_id,
    country_name: stage.country_name,
    country_code: stage.country_code,
    location: stage.location,
    circuit_short_name: stage.circuit_short_name,
  }));
}

export function namiLiveTargetAt(value = Date.now(), { leadMs = DEFAULT_AUTO_LEAD_MS, graceMs = DEFAULT_AUTO_GRACE_MS } = {}) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value));
  const now = Number.isFinite(parsed) ? parsed : Date.now();
  const lead = Math.max(0, Number(leadMs) || 0);
  const grace = Math.max(0, Number(graceMs) || 0);
  const active = NAMI_AUTO_STAGE_LIST.find((stage) => {
    const start = Date.parse(stage.date_start);
    const end = Date.parse(stage.date_end);
    return now >= start - lead && now <= end + grace;
  });
  if (active) {
    const start = Date.parse(active.date_start);
    const end = Date.parse(active.date_end);
    const autoState = now < start ? "prestart" : now <= end ? "active" : "post-session";
    return {
      ...active,
      auto_state: autoState,
      polling: true,
      starts_in_ms: start - now,
      ends_in_ms: end - now,
    };
  }
  const previous = NAMI_AUTO_STAGE_LIST.slice().reverse().find((stage) => Date.parse(stage.date_end) < now) || null;
  const next = NAMI_AUTO_STAGE_LIST.find((stage) => Date.parse(stage.date_start) > now) || null;
  const previousDistance = previous ? now - Date.parse(previous.date_end) : Infinity;
  const nextDistance = next ? Date.parse(next.date_start) - now : Infinity;
  const nearest = previousDistance <= nextDistance ? previous : next;
  if (!nearest) return null;
  return {
    ...nearest,
    auto_state: nearest === previous ? "previous" : "next",
    polling: false,
    starts_in_ms: Date.parse(nearest.date_start) - now,
    ends_in_ms: Date.parse(nearest.date_end) - now,
  };
}

export function decodeNamiData(value) {
  const encoded = text(value);
  if (!encoded) throw new Error("纳米接口记录缺少 data 字段");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("纳米接口 data 不是有效的 Base64");
  try {
    const value = decode(bytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decoded value is not an object");
    return value;
  } catch (messagePackError) {
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decoded value is not an object");
      return value;
    } catch {
      throw new Error(`纳米接口 MessagePack 解码失败：${messagePackError.message}`);
    }
  }
}

function recordTimeIso(value) {
  const raw = text(value);
  if (!raw) return null;
  const chinaTime = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  const milliseconds = Date.parse(chinaTime ? `${chinaTime[1]}T${chinaTime[2]}+08:00` : raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function responseRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && typeof payload.data === "string") return [payload];
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.data && typeof payload.data === "object" && typeof payload.data.data === "string") return [payload.data];
  return [];
}

export async function fetchNamiSnapshot({ token, provider, stageId, live = false, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const source = namiProvider(provider);
  const stage = namiStage(stageId);
  if (!source) throw new Error("纳米数据源仅支持 radar、dash、official");
  if (!stage) throw new Error("该 stage_id 不在 2026 全年纳米节点目录中");
  if (!text(token)) throw new Error("服务端缺少 NANA_HISTORY_TOKEN");
  const url = new URL("https://api.nana1024.com/d1/api/f1/his");
  const params = live
    ? { token, pid: source.pid, sport_id: 30, stage_id: stage.stage_id, live: 1 }
    : { token, pid: NAMI_HISTORY_PID, sport_id: 30, stage_id: stage.stage_id, nm: 1 };
  Object.entries(params)
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`纳米 ${source.label} 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`纳米 ${source.label} 请求失败：${error.message || error}`);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`纳米 ${source.label} 请求失败（HTTP ${response.status}）`);
  const records = responseRecords(payload).filter((record) => record && typeof record.data === "string");
  if (!records.length) throw new Error(`纳米 ${source.label} 没有返回可解码记录`);
  const record = records.at(-1);
  return {
    data: decodeNamiData(record.data),
    provider: source,
    stage,
    live: Boolean(live),
    recordCount: records.length,
    recordTime: record.time || null,
    recordTimeIso: recordTimeIso(record.time),
    recordTimes: records.map((item) => ({ time: item.time || null, time_utc: recordTimeIso(item.time) })),
  };
}

function durationSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parts = String(value).replace(/^\+/, "").split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function resultFlags(status) {
  const key = String(status ?? "").trim().toUpperCase();
  return {
    dnf: key === "305" || key === "DNF" || key === "RETIRED",
    dns: key === "303" || key === "DNS" || key === "DID NOT START",
    dsq: key === "304" || key === "DSQ" || key === "DISQUALIFIED",
  };
}

function weatherRows(extra) {
  const rows = Array.isArray(extra?.weather_records) ? extra.weather_records : [];
  return rows.filter((row) => row && [row.air_temperature, row.track_temperature, row.humidity, row.pressure, row.wind_speed, row.wind_direction]
    .some((value) => value !== null && value !== undefined && value !== ""));
}

function stintRows(competitor, extra, stage) {
  const id = competitor?._id;
  if (id === null || id === undefined) return [];
  const key = String(id);
  const historical = Array.isArray(extra?.tire_history?.[key]) ? extra.tire_history[key].slice() : [];
  const current = extra?.tire_info?.[key];
  const pitCount = numeric(competitor.pitstop_count);
  if (current && (pitCount === null || historical.length < pitCount + 1)) historical.push(current);
  let nextLap = 1;
  return historical.map((item, index) => {
    const totalLaps = Math.max(0, Math.floor(numeric(item?.total_laps) ?? 0));
    const row = {
      meeting_key: stage.meeting_key,
      session_key: stage.stage_id,
      driver_number: competitor.car_number,
      stint_number: index + 1,
      lap_start: nextLap,
      lap_end: totalLaps ? nextLap + totalLaps - 1 : nextLap - 1,
      compound: text(item?.compound).toUpperCase(),
    };
    nextLap += totalLaps;
    return row;
  }).filter((row) => row.compound && row.lap_end >= row.lap_start);
}

export function namiBackendSnapshot(decoded, mapping, metadata = {}) {
  const source = normaliseNanaSnapshot(decoded, mapping);
  const stage = namiStage(metadata.stageId ?? decoded?.id ?? 103697) || NAMI_STAGES[103697];
  const provider = namiProvider(metadata.provider) || NAMI_PROVIDERS.radar;
  return {
    ...source,
    id: source.id ?? stage.stage_id,
    parent_id: source.parent_id ?? stage.meeting_key,
    source_name: `纳米-${provider.label}`,
    data_source: "nami",
    source_session: `nami-${provider.key}`,
    fetched_at: metadata.recordTimeIso || source.event_time_utc || new Date().toISOString(),
    upstream_record_time: metadata.recordTime || null,
    meeting: {
      meeting_key: stage.meeting_key,
      meeting_name: stage.meeting_name,
      country_name: stage.country_name,
      country_code: stage.country_code,
      location: stage.location,
      year: stage.season,
      round: stage.round,
    },
    session: {
      session_key: stage.stage_id,
      meeting_key: stage.meeting_key,
      session_name: stage.session_name,
      session_type: stage.session_type,
      date_start: stage.date_start,
      date_end: stage.date_end,
      year: stage.season,
      country_name: stage.country_name,
      country_code: stage.country_code,
      location: stage.location,
    },
    nami: {
      provider: provider.key,
      provider_label: provider.label,
      pid: provider.pid,
      stage_id: stage.stage_id,
      live: Boolean(metadata.live),
      record_count: metadata.recordCount ?? 1,
      record_time: metadata.recordTime || null,
      record_time_utc: metadata.recordTimeIso || null,
      records: metadata.recordTimes || [],
    },
  };
}

export function namiSessionData(decoded, mapping, metadata = {}) {
  const mapped = namiBackendSnapshot(decoded, mapping, metadata);
  const stage = namiStage(metadata.stageId ?? mapped.id) || NAMI_STAGES[103697];
  const competitors = Array.isArray(mapped.competitors) ? mapped.competitors : [];
  const extra = mapped.extra || {};
  const drivers = competitors.map((row) => ({
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    driver_number: row.car_number,
    full_name: row.name || `车号 ${row.car_number}`,
    broadcast_name: row.name || `车号 ${row.car_number}`,
    name_acronym: row.abbr || "",
    team_name: row.teamname || "",
  }));
  const sessionResult = competitors.map((row) => ({
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    driver_number: row.car_number,
    position: numeric(row.position),
    number_of_laps: numeric(row.laps),
    duration: Number(row.position) === 1 ? durationSeconds(row.time?.value) : null,
    gap_to_leader: Number(row.position) === 1 ? null : (row.gap_to_leader ?? row.time?.value ?? null),
    points: numeric(row.points),
    ...resultFlags(row.status),
  }));
  const recordDate = metadata.recordTimeIso || mapped.fetched_at || stage.date_end;
  const laps = competitors.map((row) => {
    const key = row._id === null || row._id === undefined ? null : String(row._id);
    const sectors = key ? extra.sectors?.[key] : null;
    return {
      meeting_key: stage.meeting_key,
      session_key: stage.stage_id,
      driver_number: row.car_number,
      lap_number: numeric(row.laps),
      lap_duration: durationSeconds(key ? extra.last_lap_time?.[key] : null),
      duration_sector_1: durationSeconds(sectors?.[0]?.time),
      duration_sector_2: durationSeconds(sectors?.[1]?.time),
      duration_sector_3: durationSeconds(sectors?.[2]?.time),
      date_start: recordDate,
      is_pit_out_lap: false,
    };
  }).filter((row) => row.lap_number !== null);
  const positions = competitors.map((row) => ({
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    driver_number: row.car_number,
    position: numeric(row.position),
    date: recordDate,
  }));
  const intervals = competitors.map((row) => ({
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    driver_number: row.car_number,
    interval: row.interval ?? null,
    gap_to_leader: row.gap_to_leader ?? null,
    date: recordDate,
  }));
  const pit = competitors.flatMap((row) => Array.from({ length: Math.max(0, Math.floor(numeric(row.pitstop_count) ?? 0)) }, (_, index) => ({
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    driver_number: row.car_number,
    lap_number: null,
    pit_duration: null,
    stop_number: index + 1,
  })));
  const stints = competitors.flatMap((row) => stintRows(row, extra, stage));
  const raceControl = (Array.isArray(mapped.messages) ? mapped.messages : []).map((row) => ({
    ...row,
    meeting_key: stage.meeting_key,
    session_key: stage.stage_id,
    lap_number: row.lap_number ?? row.lap ?? null,
    message: row.text_en || row.message || "",
    date: row.date || (row.utc ? new Date(Number(row.utc) * 1000).toISOString() : recordDate),
  }));
  return {
    meeting: mapped.meeting,
    session: mapped.session,
    drivers,
    session_result: sessionResult,
    laps,
    pit,
    position: positions,
    intervals,
    stints,
    race_control: raceControl,
    weather: weatherRows(extra),
    mapped,
    data_source: "nami",
    source_session: mapped.source_session,
    synced_at: recordDate,
    cache: false,
    nami: mapped.nami,
  };
}
