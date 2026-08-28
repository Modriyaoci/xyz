const F1_TELEMETRY_API_BASE = "https://api.f1telemetry.com/";
const F1_TELEMETRY_WS_URL = "wss://api.f1telemetry.com/";

const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
const textDecoder = typeof TextDecoder === "function" ? new TextDecoder() : null;

function bytesForText(value) {
  if (textEncoder) return textEncoder.encode(value);
  return Uint8Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0));
}

function textForBytes(value) {
  if (textDecoder) return textDecoder.decode(value);
  return decodeURIComponent(Array.from(value, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
}

function pushUint(chunks, major, value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("CBOR length is out of range");
  if (amount < 24) {
    chunks.push(Uint8Array.of((major << 5) | amount));
  } else if (amount <= 0xff) {
    chunks.push(Uint8Array.of((major << 5) | 24, amount));
  } else if (amount <= 0xffff) {
    chunks.push(Uint8Array.of((major << 5) | 25, amount >> 8, amount & 0xff));
  } else if (amount <= 0xffffffff) {
    chunks.push(Uint8Array.of((major << 5) | 26, amount >>> 24, amount >>> 16, amount >>> 8, amount));
  } else {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(amount), false);
    chunks.push(Uint8Array.of((major << 5) | 27), bytes);
  }
}

function encodeCborValue(value, chunks) {
  if (value === null) {
    chunks.push(Uint8Array.of(0xf6));
    return;
  }
  if (value === undefined) {
    chunks.push(Uint8Array.of(0xf7));
    return;
  }
  if (value === false || value === true) {
    chunks.push(Uint8Array.of(value ? 0xf5 : 0xf4));
    return;
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) {
      pushUint(chunks, 0, value);
      return;
    }
    if (Number.isSafeInteger(value) && value < 0 && value >= -9007199254740991) {
      pushUint(chunks, 1, -1 - value);
      return;
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    chunks.push(Uint8Array.of(0xfb), bytes);
    return;
  }
  if (typeof value === "string") {
    const bytes = bytesForText(value);
    pushUint(chunks, 3, bytes.byteLength);
    chunks.push(bytes);
    return;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    pushUint(chunks, 2, bytes.byteLength);
    chunks.push(bytes);
    return;
  }
  if (Array.isArray(value)) {
    pushUint(chunks, 4, value.length);
    value.forEach((item) => encodeCborValue(item, chunks));
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    pushUint(chunks, 5, keys.length);
    keys.forEach((key) => {
      encodeCborValue(key, chunks);
      encodeCborValue(value[key], chunks);
    });
    return;
  }
  throw new Error(`Unsupported CBOR value: ${typeof value}`);
}

export function encodeF1TelemetryMessage(value) {
  const chunks = [];
  encodeCborValue(value, chunks);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return result;
}

function decodeLength(view, additional, state) {
  if (additional < 24) return additional;
  if (additional === 24) return view[state.offset++];
  if (additional === 25) {
    const value = view[state.offset] * 256 + view[state.offset + 1];
    state.offset += 2;
    return value;
  }
  if (additional === 26) {
    const value = new DataView(view.buffer, view.byteOffset + state.offset, 4).getUint32(0, false);
    state.offset += 4;
    return value;
  }
  if (additional === 27) {
    const value = new DataView(view.buffer, view.byteOffset + state.offset, 8).getBigUint64(0, false);
    state.offset += 8;
    return Number(value);
  }
  if (additional === 31) return null;
  throw new Error(`Unsupported CBOR additional information: ${additional}`);
}

function decodeCborValue(view, state) {
  const first = view[state.offset++];
  if (first === undefined) throw new Error("Unexpected end of CBOR message");
  const major = first >> 5;
  const additional = first & 31;
  if (major === 0) return decodeLength(view, additional, state);
  if (major === 1) return -1 - decodeLength(view, additional, state);
  if (major === 2) {
    const length = decodeLength(view, additional, state);
    if (length === null) {
      const parts = [];
      while (view[state.offset] !== 0xff) parts.push(decodeCborValue(view, state));
      state.offset += 1;
      const size = parts.reduce((total, part) => total + part.byteLength, 0);
      const result = new Uint8Array(size);
      let offset = 0;
      parts.forEach((part) => { result.set(part, offset); offset += part.byteLength; });
      return result;
    }
    const result = view.slice(state.offset, state.offset + length);
    state.offset += length;
    return result;
  }
  if (major === 3) {
    const length = decodeLength(view, additional, state);
    if (length === null) {
      let value = "";
      while (view[state.offset] !== 0xff) value += decodeCborValue(view, state);
      state.offset += 1;
      return value;
    }
    const result = textForBytes(view.slice(state.offset, state.offset + length));
    state.offset += length;
    return result;
  }
  if (major === 4) {
    const length = decodeLength(view, additional, state);
    const result = [];
    if (length === null) {
      while (view[state.offset] !== 0xff) result.push(decodeCborValue(view, state));
      state.offset += 1;
      return result;
    }
    for (let index = 0; index < length; index += 1) result.push(decodeCborValue(view, state));
    return result;
  }
  if (major === 5) {
    const length = decodeLength(view, additional, state);
    const result = {};
    const readPair = () => {
      const key = decodeCborValue(view, state);
      result[String(key)] = decodeCborValue(view, state);
    };
    if (length === null) {
      while (view[state.offset] !== 0xff) readPair();
      state.offset += 1;
    } else {
      for (let index = 0; index < length; index += 1) readPair();
    }
    return result;
  }
  if (major === 6) {
    decodeLength(view, additional, state);
    return decodeCborValue(view, state);
  }
  if (additional === 20) return false;
  if (additional === 21) return true;
  if (additional === 22) return null;
  if (additional === 23) return undefined;
  if (additional === 24) return view[state.offset++];
  if (additional === 25) {
    const bits = new DataView(view.buffer, view.byteOffset + state.offset, 2).getUint16(0, false);
    state.offset += 2;
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  if (additional === 26) {
    const value = new DataView(view.buffer, view.byteOffset + state.offset, 4).getFloat32(0, false);
    state.offset += 4;
    return value;
  }
  if (additional === 27) {
    const value = new DataView(view.buffer, view.byteOffset + state.offset, 8).getFloat64(0, false);
    state.offset += 8;
    return value;
  }
  if (additional === 31) return { __cborBreak: true };
  throw new Error(`Unsupported CBOR simple value: ${additional}`);
}

export function decodeF1TelemetryMessage(input) {
  if (typeof input === "string") return JSON.parse(input);
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  if (!bytes) throw new Error("Unsupported WebSocket message type");
  return decodeCborValue(bytes, { offset: 0 });
}

export function parseF1Time(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text || !/^\d+(?::\d+)?(?::\d+(?:\.\d+)?)?$/.test(text)) return null;
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoWithOffset(value, offset) {
  if (!value) return null;
  const text = String(value);
  if (/z|[+-]\d\d:?\d\d$/i.test(text)) return text;
  const match = String(offset || "").match(/^([+-]?\d\d):?(\d\d)/);
  return match ? `${text}${match[1].startsWith("-") ? "-" : "+"}${match[1].replace(/^[+-]/, "")}:${match[2]}` : `${text}Z`;
}

function isoUtc(value, fallback) {
  if (!value) return fallback;
  const text = String(value);
  return /z|[+-]\d\d:?\d\d$/i.test(text) ? text : `${text}Z`;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function lineEntries(value) {
  return Object.entries(asObject(value)).filter(([key, item]) => key !== "_kf" && item && typeof item === "object");
}

function normaliseSegmentStatus(value) {
  if (value && typeof value === "object") return numberOrNull(value.Status);
  return numberOrNull(value);
}

function normaliseStints(driverNumber, source) {
  const raw = source && typeof source === "object" ? source : {};
  const entries = Array.isArray(raw) ? raw.map((item, index) => [index, item]) : Object.entries(raw);
  return entries.map(([index, stint]) => {
    const total = numberOrNull(stint?.TotalLaps) ?? 0;
    const startLaps = numberOrNull(stint?.StartLaps) ?? 0;
    return {
      driver_number: Number(driverNumber),
      stint_number: Number(index) + 1,
      compound: String(stint?.Compound || "UNKNOWN").toUpperCase(),
      lap_start: Math.max(1, startLaps + 1),
      lap_end: Math.max(0, startLaps + total),
      lap_number: numberOrNull(stint?.LapNumber),
      lap_time: stint?.LapTime || "",
      total_laps: total,
      start_laps: startLaps,
      is_new: String(stint?.New).toLowerCase() === "true",
      lap_flags: numberOrNull(stint?.LapFlags) ?? 0,
    };
  });
}

function driverRows(raw) {
  return lineEntries(raw).map(([key, driver]) => {
    const driverNumber = numberOrNull(driver.RacingNumber ?? key);
    return {
      driver_number: driverNumber,
      full_name: driver.FullName || `${driver.FirstName || ""} ${driver.LastName || ""}`.trim(),
      first_name: driver.FirstName || "",
      last_name: driver.LastName || "",
      name_acronym: driver.Tla || "",
      team_name: driver.TeamName || "",
      team_colour: driver.TeamColour || "",
      headshot_url: driver.HeadshotUrl || "",
    };
  }).filter((driver) => driver.driver_number != null);
}

function timingRows(raw, timestamp) {
  return lineEntries(raw).map(([key, line]) => {
    const driverNumber = numberOrNull(line.RacingNumber ?? key);
    const sectors = Array.isArray(line.Sectors) ? line.Sectors : [];
    const lastLap = parseF1Time(line.LastLapTime?.Value);
    const bestLap = parseF1Time(line.BestLapTime?.Value);
    const row = {
      driver_number: driverNumber,
      position: numberOrNull(line.Position),
      number_of_laps: numberOrNull(line.NumberOfLaps),
      gap_to_leader: line.GapToLeader ?? "",
      interval: line.IntervalToPositionAhead?.Value ?? "",
      duration: null,
      dnf: Boolean(line.Retired),
      dns: false,
      dsq: false,
      date: timestamp,
    };
    if (lastLap != null) row.last_lap_duration = lastLap;
    if (bestLap != null) row.best_lap_duration = bestLap;
    sectors.forEach((sector, index) => {
      const sectorNumber = index + 1;
      const current = numberOrNull(sector?.Value);
      const previous = numberOrNull(sector?.PreviousValue);
      if (current != null) row[`duration_sector_${sectorNumber}`] = current;
      else if (previous != null) row[`duration_sector_${sectorNumber}`] = previous;
      row[`segments_sector_${sectorNumber}`] = (Array.isArray(sector?.Segments) ? sector.Segments : []).map(normaliseSegmentStatus).filter((value) => value != null);
    });
    return row;
  }).filter((row) => row.driver_number != null);
}

function raceControlRows(raw, fallbackDate) {
  return asArray(raw?.Messages).map((message) => {
    const date = isoUtc(message?.Utc || message?.Date, fallbackDate);
    return {
      date,
      utc: date,
      lap_number: numberOrNull(message?.Lap),
      lap: numberOrNull(message?.Lap),
      message: String(message?.Message || ""),
      text_en: String(message?.Message || ""),
      text_zh: message?.MessageTranslated || null,
      category: message?.Category || "",
      flag: message?.Flag || "",
      scope: message?.Scope || "",
      sector: numberOrNull(message?.Sector),
      racing_number: message?.RacingNumber || "",
      status: message?.Status || "",
      mode: message?.Mode || "",
    };
  }).filter((message) => message.message);
}

function weatherRows(raw, timestamp) {
  if (!raw || typeof raw !== "object") return [];
  return [{
    date: timestamp,
    air_temperature: numberOrNull(raw.AirTemp),
    track_temperature: numberOrNull(raw.TrackTemp),
    humidity: numberOrNull(raw.Humidity),
    pressure: numberOrNull(raw.Pressure),
    wind_speed: numberOrNull(raw.WindSpeed),
    wind_direction: numberOrNull(raw.WindDirection),
    rainfall: numberOrNull(raw.Rainfall),
  }];
}

function stintsRows(raw, timingAppData) {
  const result = [];
  const series = asObject(raw?.Stints);
  lineEntries(series).forEach(([driverNumber, stints]) => result.push(...normaliseStints(driverNumber, stints)));
  if (result.length) return result;
  lineEntries(timingAppData?.Lines).forEach(([driverNumber, line]) => result.push(...normaliseStints(driverNumber, line?.Stints)));
  return result;
}

function sessionFromState(info, lapCount) {
  const meeting = asObject(info?.Meeting);
  const country = asObject(meeting.Country);
  const offset = info?.GmtOffset;
  return {
    session_key: numberOrNull(info?.Key),
    session_name: info?.Name || info?.Type || "",
    session_type: info?.Type || info?.Name || "",
    date_start: isoWithOffset(info?.StartDate, offset),
    date_end: isoWithOffset(info?.EndDate, offset),
    gmt_offset: offset || "",
    session_status: info?.SessionStatus || "",
    laps_completed: numberOrNull(lapCount?.CurrentLap),
    total_laps: numberOrNull(lapCount?.TotalLaps),
  };
}

export function adaptF1TelemetryState(raw, { requestedMeetingKey = null, requestedSessionKey = null, fetchedAt = new Date().toISOString() } = {}) {
  const source = raw?.R && typeof raw.R === "object" ? raw.R : asObject(raw);
  const info = asObject(source.SessionInfo);
  const meetingInfo = asObject(info.Meeting);
  const meetingKey = numberOrNull(meetingInfo.Key);
  const sessionKey = numberOrNull(info.Key);
  if (requestedMeetingKey != null && meetingKey != null && Number(requestedMeetingKey) !== meetingKey) {
    throw new Error(`数据源当前分站为 ${meetingKey}，不是所选分站 ${requestedMeetingKey}`);
  }
  if (requestedSessionKey != null && sessionKey != null && Number(requestedSessionKey) !== sessionKey) {
    throw new Error(`数据源当前节点为 ${sessionKey}，不是所选节点 ${requestedSessionKey}`);
  }
  const timestamp = fetchedAt;
  const drivers = driverRows(source.DriverList);
  const timing = timingRows(source.TimingData?.Lines, timestamp);
  const timingByCar = new Map(timing.map((row) => [Number(row.driver_number), row]));
  const laps = [];
  timing.forEach((row) => {
    if (row.last_lap_duration == null && row.best_lap_duration == null) return;
    const duration = row.last_lap_duration ?? row.best_lap_duration;
    laps.push({
      driver_number: row.driver_number,
      lap_number: row.number_of_laps,
      lap_duration: duration,
      date_start: timestamp,
      is_pit_out_lap: false,
      duration_sector_1: row.duration_sector_1,
      duration_sector_2: row.duration_sector_2,
      duration_sector_3: row.duration_sector_3,
      segments_sector_1: row.segments_sector_1 || [],
      segments_sector_2: row.segments_sector_2 || [],
      segments_sector_3: row.segments_sector_3 || [],
    });
    if (row.best_lap_duration != null && row.best_lap_duration !== duration) {
      laps.push({
        driver_number: row.driver_number,
        lap_number: row.number_of_laps,
        lap_duration: row.best_lap_duration,
        date_start: timestamp,
        is_pit_out_lap: false,
        duration_sector_1: row.duration_sector_1,
        duration_sector_2: row.duration_sector_2,
        duration_sector_3: row.duration_sector_3,
        segments_sector_1: row.segments_sector_1 || [],
        segments_sector_2: row.segments_sector_2 || [],
        segments_sector_3: row.segments_sector_3 || [],
      });
    }
  });
  const intervals = timing.map((row) => ({
    driver_number: row.driver_number,
    date: timestamp,
    interval: row.interval,
    gap_to_leader: row.gap_to_leader,
  }));
  const position = timing.map((row) => ({ driver_number: row.driver_number, position: row.position, date: timestamp }));
  const pit = [];
  timing.forEach((row) => {
    const count = numberOrNull(source.TimingData?.Lines?.[String(row.driver_number)]?.NumberOfPitStops) ?? 0;
    for (let index = 0; index < count; index += 1) pit.push({ driver_number: row.driver_number, date: timestamp, lap_number: null });
  });
  const stints = stintsRows(source.TyreStintSeries, source.TimingAppData);
  const session = sessionFromState(info, source.LapCount);
  const meeting = {
    meeting_key: meetingKey ?? numberOrNull(requestedMeetingKey),
    country_name: asObject(meetingInfo.Country).Name || "",
    location: meetingInfo.Location || "",
    meeting_name: meetingInfo.Name || "",
    official_name: meetingInfo.OfficialName || "",
  };
  const data = {
    meeting,
    session,
    drivers,
    session_result: timing.map((row) => ({ ...row })),
    laps,
    pit,
    position,
    intervals,
    stints,
    race_control: raceControlRows(source.RaceControlMessages, timestamp),
    weather: weatherRows(source.WeatherData, timestamp),
    live: true,
    fetched_at: timestamp,
    f1telemetry: {
      session_status: info.SessionStatus || "",
      archive_status: asObject(info.ArchiveStatus).Status || "",
      track_status: source.TrackStatus || null,
      timing_stats: source.TimingStats || null,
      top_three: source.TopThree || null,
      timing_app_data: source.TimingAppData || null,
      tyre_stint_series: source.TyreStintSeries || null,
      team_radio: source.TeamRadio || null,
    },
  };
  data.session_result.forEach((row) => {
    const line = timingByCar.get(Number(row.driver_number));
    row.number_of_pit_stops = numberOrNull(source.TimingData?.Lines?.[String(row.driver_number)]?.NumberOfPitStops) ?? 0;
    row.last_lap_time = line?.last_lap_duration ?? null;
    row.best_lap_time = line?.best_lap_duration ?? null;
  });
  return data;
}

function webSocketConstructor() {
  if (typeof WebSocket === "function") return WebSocket;
  throw new Error("当前运行环境不支持 WebSocket");
}

/**
 * Keep the F1 Telemetry connection open. The service sends a complete state
 * package repeatedly after the initial get:state request.
 */
export function openF1TelemetryStream({
  requestedMeetingKey = null,
  requestedSessionKey = null,
  timeoutMs = 30000,
  onState,
  onError,
  onClose,
} = {}) {
  const Socket = webSocketConstructor();
  const socket = new Socket(F1_TELEMETRY_WS_URL);
  let firstStateReceived = false;
  let closedByCaller = false;
  const timer = setTimeout(() => {
    const error = new Error(`F1 Telemetry 请求超时（${timeoutMs / 1000}秒）`);
    try { socket.close(); } catch { /* ignore close errors */ }
    onError?.(error);
  }, timeoutMs);
  const reportError = (error) => {
    if (!closedByCaller) onError?.(error instanceof Error ? error : new Error(String(error)));
  };
  const requestState = () => {
    if (socket.readyState !== 1) return false;
    try {
      socket.send(encodeF1TelemetryMessage({ type: "get:state" }));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  const close = () => {
    closedByCaller = true;
    clearTimeout(timer);
    try { socket.close(); } catch { /* ignore close errors */ }
  };
  try {
    socket.binaryType = "arraybuffer";
    socket.onopen = () => requestState();
    socket.onerror = () => reportError(new Error("F1 Telemetry WebSocket 连接失败"));
    socket.onclose = () => {
      clearTimeout(timer);
      if (!closedByCaller) onClose?.();
    };
    socket.onmessage = async (event) => {
      try {
        let input = event.data;
        if (typeof Blob !== "undefined" && input instanceof Blob) input = await input.arrayBuffer();
        const decoded = decodeF1TelemetryMessage(input);
        if (decoded?.type === "auth:error") return reportError(new Error("F1 Telemetry 身份验证失败"));
        const source = decoded?.R || decoded;
        if (!source?.SessionInfo) return;
        if (!firstStateReceived) {
          firstStateReceived = true;
          clearTimeout(timer);
        }
        onState?.(adaptF1TelemetryState(decoded, { requestedMeetingKey, requestedSessionKey }));
      } catch (error) { reportError(error); }
    };
  } catch (error) {
    clearTimeout(timer);
    reportError(error);
  }
  return { close, requestState, socket };
}

export async function fetchF1TelemetryState({ requestedMeetingKey = null, requestedSessionKey = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let stream;
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      stream?.close();
      if (error) reject(error);
      else resolve(data);
    };
    try {
      stream = openF1TelemetryStream({
        requestedMeetingKey,
        requestedSessionKey,
        timeoutMs,
        onState: (data) => finish(null, data),
        onError: (error) => finish(error),
        onClose: () => finish(new Error("F1 Telemetry WebSocket 已断开")),
      });
    } catch (error) {
      finish(error);
    }
  });
}

export const f1TelemetryApiBase = F1_TELEMETRY_API_BASE;
export const f1TelemetryWebSocketUrl = F1_TELEMETRY_WS_URL;
