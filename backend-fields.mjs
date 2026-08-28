const DRIVER_IDS = {
  ALB: 347504, LIN: 347549, SAI: 347548, LEC: 347492, OCO: 347547, ALO: 347502,
  COL: 347540, BOR: 347539, RUS: 347501, HAD: 347537, ANT: 347534, STR: 347503,
  NOR: 347506, HAM: 347542, LAW: 347514, VER: 347482, HUL: 347544, BEA: 347520,
  PIA: 347528, GAS: 347499, PER: 347519, BOT: 347525, CRA: 347908, FOR: 368438,
  HER: 368439, IWA: 347538, BEG: 347535, BRO: 347536, VES: 347526, ARO: 347526,
  HIR: 347541, TSU: 347546,
};

const DRIVER_IDS_BY_NAME = {
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
};

const DRIVER_IDS_BY_CAR = {
  1: 347506, 3: 347482, 5: 347539, 10: 347499, 11: 347519, 12: 347534,
  14: 347502, 16: 347492, 18: 347503, 22: 347546, 23: 347504, 27: 347544,
  30: 347514, 31: 347547, 41: 347549, 43: 347540, 44: 347542, 55: 347548,
  63: 347501, 77: 347525, 81: 347528, 87: 347520,
};

const TEAM_IDS = {
  alpine: 385366, "aston martin": 385362, audi: 394048, cadillac: 390378,
  ferrari: 385364, "haas f1 team": 385361, mclaren: 385367, mercedes: 385358,
  "racing bulls": 385363, "red bull racing": 385355, williams: 385365,
};

const STATUS_COLORS = { 0: "red", 2048: "yellow", 2049: "green", 2051: "purple", 2064: "blue" };
const RACE_SESSIONS = new Set(["Race", "Sprint"]);

export const backendDriverIds = Object.freeze({ ...DRIVER_IDS });
export const backendTeamIds = Object.freeze({ ...TEAM_IDS });

export function identityKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function lookup(map, value) {
  const key = identityKey(value);
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(map, key)) return Number(map[key]);
  for (const [alias, id] of Object.entries(map)) {
    if (key.endsWith(` ${alias}`) || alias.endsWith(` ${key}`)) return Number(id);
  }
  return null;
}

export function resolveBackendDriverId(driver) {
  const acronym = String(driver?.name_acronym || driver?.code || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DRIVER_IDS, acronym)) return Number(DRIVER_IDS[acronym]);
  const fullName = driver?.full_name || `${driver?.first_name || ""} ${driver?.last_name || ""}`;
  return lookup(DRIVER_IDS_BY_NAME, fullName) ?? DRIVER_IDS_BY_CAR[Number(driver?.driver_number)] ?? null;
}

export function resolveBackendTeamId(team) {
  return lookup(TEAM_IDS, team);
}

function numeric(value) {
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function formatBackendTime(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && !/^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  const total = numeric(value);
  if (total === null) return String(value).trim();
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = (total % 60).toFixed(3).padStart(6, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${Math.floor(total / 60)}:${seconds}`;
}

export function formatBackendGap(value, { blankZero = false } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(text)) return text;
  const amount = Number(text);
  if (!Number.isFinite(amount)) return text;
  if (blankZero && amount === 0) return "";
  return amount === 0 ? "0" : `+${amount.toFixed(3)}`;
}

function phaseValue(value, index = 2) {
  return Array.isArray(value) ? (value[index] ?? null) : value;
}

function latestByDriver(rows, dateFields = ["date", "date_start"]) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const car = Number(row?.driver_number);
    if (!Number.isFinite(car)) continue;
    const stamp = dateFields.map((field) => Date.parse(row?.[field] || "") || 0).sort((a, b) => b - a)[0] || 0;
    const previous = latest.get(car);
    const previousStamp = previous ? dateFields.map((field) => Date.parse(previous?.[field] || "") || 0).sort((a, b) => b - a)[0] || 0 : -1;
    if (!previous || stamp >= previousStamp) latest.set(car, row);
  }
  return latest;
}

function sortedLaps(rows) {
  return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => Number(a.lap_number) - Number(b.lap_number) || Date.parse(a.date_start || "") - Date.parse(b.date_start || ""));
}

function validLaps(rows) {
  return sortedLaps(rows).filter((lap) => numeric(lap.lap_duration) !== null && !lap.is_pit_out_lap);
}

function colorForStatus(status) {
  return STATUS_COLORS[Number(status)] || "gray";
}

function windDirectionAbbr(degrees) {
  const value = numeric(degrees);
  if (value === null) return "";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(value / 45) % 8];
}

function messageDriverNumber(message) {
  const direct = Number(message?.driver_number);
  if (Number.isFinite(direct)) return direct;
  const match = String(message?.message || "").match(/\bCAR\s+(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

function statusCode(raw, sessionEnded) {
  if (raw?.dsq) return 304;
  if (raw?.dns) return 303;
  if (raw?.dnf) return 305;
  return sessionEnded ? 302 : 301;
}

function totalStintLaps(stint) {
  const start = numeric(stint?.lap_start);
  const end = numeric(stint?.lap_end);
  return start === null || end === null ? null : Math.max(0, Math.floor(end - start + 1));
}

function mapStint(stint) {
  return { compound: String(stint?.compound || "").toUpperCase(), total_laps: totalStintLaps(stint) };
}

function mergeByCar(generated, existing) {
  const existingByCar = new Map((Array.isArray(existing) ? existing : []).map((row) => [Number(row?.car_number), row]));
  const cars = new Set([...generated.map((row) => Number(row.car_number)), ...existingByCar.keys()]);
  return Array.from(cars).filter(Number.isFinite).sort((a, b) => {
    const left = generated.find((row) => Number(row.car_number) === a)?.position;
    const right = generated.find((row) => Number(row.car_number) === b)?.position;
    return (numeric(left) ?? 999) - (numeric(right) ?? 999) || a - b;
  }).map((car) => ({ ...(generated.find((row) => Number(row.car_number) === car) || { car_number: car }), ...(existingByCar.get(car) || {}) }));
}

export function mapOpenF1ToBackend(data, existing = null) {
  const source = data && typeof data === "object" ? data : {};
  const session = source.session || {};
  const sessionName = String(session.session_name || "");
  const sessionEnded = Date.parse(session.date_end || "") > 0 && Date.parse(session.date_end) < Date.now();
  const drivers = new Map((Array.isArray(source.drivers) ? source.drivers : []).map((driver) => [Number(driver.driver_number), driver]));
  const rawResults = Array.isArray(source.session_result) ? source.session_result : [];
  const resultByCar = new Map(rawResults.map((row) => [Number(row.driver_number), row]));
  // F1 Telemetry publishes the live sector in TimingData and the driver's
  // personal best sector in TimingStats. Keep both sources separate so the
  // current sector is never shown as the personal best by accident.
  const timingStatsLines = source.f1telemetry?.timing_stats?.Lines || {};
  const positions = latestByDriver(source.position);
  const intervals = latestByDriver(source.intervals || source.intervals_race);
  const lapsByCar = new Map();
  for (const lap of Array.isArray(source.laps) ? source.laps : []) {
    const car = Number(lap?.driver_number);
    if (!Number.isFinite(car)) continue;
    if (!lapsByCar.has(car)) lapsByCar.set(car, []);
    lapsByCar.get(car).push(lap);
  }
  const pitsByCar = new Map();
  for (const pit of Array.isArray(source.pit) ? source.pit : []) {
    const car = Number(pit?.driver_number);
    if (!Number.isFinite(car)) continue;
    pitsByCar.set(car, (pitsByCar.get(car) || 0) + 1);
  }
  const stintsByCar = new Map();
  for (const stint of Array.isArray(source.stints) ? source.stints : []) {
    const car = Number(stint?.driver_number);
    if (!Number.isFinite(car)) continue;
    if (!stintsByCar.has(car)) stintsByCar.set(car, []);
    stintsByCar.get(car).push(stint);
  }
  for (const rows of stintsByCar.values()) rows.sort((a, b) => Number(a.stint_number) - Number(b.stint_number));

  const allValidLaps = Array.from(lapsByCar.values()).flatMap(validLaps);
  const sessionBestLap = allValidLaps.map((lap) => numeric(lap.lap_duration)).filter((value) => value !== null);
  const sessionBest = sessionBestLap.length ? Math.min(...sessionBestLap) : null;
  const sessionBestSectors = [1, 2, 3].map((sector) => {
    const values = allValidLaps.map((lap) => numeric(lap[`duration_sector_${sector}`])).filter((value) => value !== null);
    return values.length ? Math.min(...values) : null;
  });
  const winnerRaw = rawResults.find((row) => Number(row.position) === 1) || rawResults.slice().sort((a, b) => Number(a.position) - Number(b.position))[0] || null;
  const winnerLaps = numeric(winnerRaw?.number_of_laps) ?? numeric(session.laps_completed) ?? null;
  const ncThreshold = RACE_SESSIONS.has(sessionName) && winnerLaps !== null ? Math.floor(winnerLaps * 0.9) : null;
  const cars = new Set([...drivers.keys(), ...resultByCar.keys(), ...positions.keys(), ...intervals.keys(), ...lapsByCar.keys()]);
  const generatedCompetitors = Array.from(cars).filter(Number.isFinite).map((car) => {
    const driver = drivers.get(car) || {};
    const raw = resultByCar.get(car) || {};
    const position = numeric(raw.position) ?? numeric(positions.get(car)?.position);
    const lapRows = validLaps(lapsByCar.get(car) || []);
    const bestLap = lapRows.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0] || null;
    const duration = phaseValue(raw.duration);
    const intervalRow = intervals.get(car) || {};
    const gapRaw = phaseValue(raw.gap_to_leader) ?? intervalRow.gap_to_leader;
    const gap = position === 1 ? "" : formatBackendGap(gapRaw, { blankZero: true });
    const race = RACE_SESSIONS.has(sessionName);
    const timeValue = raw.dnf || raw.dns || raw.dsq
      ? ""
      : race && position !== 1
        ? (gap || formatBackendTime(duration))
        : formatBackendTime(duration);
    const laps = numeric(raw.number_of_laps) ?? (lapRows.length ? Math.max(...lapRows.map((lap) => Number(lap.lap_number) || 0)) : null);
    const positionDesc = race && !raw.dns && !raw.dsq && ncThreshold !== null && laps !== null && laps < ncThreshold ? "NC" : "";
    const backendDriverId = resolveBackendDriverId(driver);
    const backendTeamId = resolveBackendTeamId(driver.team_name);
    const competitor = {
      ...(backendDriverId == null ? {} : { id: backendDriverId }),
      ...(backendTeamId == null ? {} : { team_id: backendTeamId }),
      ...(position == null ? {} : { position }),
      ...(laps == null ? {} : { laps }),
      time: { value: timeValue },
      status: statusCode(raw, sessionEnded),
      interval: formatBackendGap(intervalRow.interval, { blankZero: true }),
      gap_to_leader: gap,
      pitstop: pitsByCar.get(car) || 0,
      fastest_lap_time: bestLap ? formatBackendTime(bestLap.lap_duration) : "",
      car_number: car,
      position_desc: positionDesc,
    };
    if (raw.points !== undefined && raw.points !== null) competitor.points = raw.points;
    return competitor;
  });
  const competitors = mergeByCar(generatedCompetitors, existing?.competitors);
  competitors.sort((a, b) => (numeric(a.position) ?? 999) - (numeric(b.position) ?? 999) || Number(a.car_number) - Number(b.car_number));
  const winner = competitors.find((row) => Number(row.position) === 1) || competitors[0] || null;
  const latestWeather = (Array.isArray(source.weather) ? source.weather : []).slice().sort((a, b) => Date.parse(a.date || "") - Date.parse(b.date || "")).at(-1);
  const weather = latestWeather ? {
    air_temperature: latestWeather.air_temperature,
    track_temperature: latestWeather.track_temperature,
    humidity: latestWeather.humidity,
    pressure: latestWeather.pressure,
    wind_speed: latestWeather.wind_speed,
    wind_direction: latestWeather.wind_direction,
    wind_direction_abbr: windDirectionAbbr(latestWeather.wind_direction),
    rainfall: latestWeather.rainfall,
  } : {};
  const extra = {
    weather,
    last_lap_time: {},
    last_lap_time_color: {},
    best_lap_time_color: {},
    sectors: {},
    mini_sectors_data: {},
    tire_info: {},
    tire_history: {},
    track_limits: {},
  };
  const raceControl = Array.isArray(source.race_control) ? source.race_control : [];
  const extensionCars = new Set([...cars, ...stintsByCar.keys()]);
  for (const car of extensionCars) {
    const driverLaps = lapsByCar.get(car) || [];
    const id = resolveBackendDriverId(drivers.get(car) || { driver_number: car });
    if (id == null) continue;
    const key = String(id);
    const timingRow = resultByCar.get(car) || {};
    const statsLine = timingStatsLines[String(car)] || timingStatsLines[car] || {};
    const bestSectorRows = Array.isArray(statsLine.BestSectors) ? statsLine.BestSectors : [];
    const valid = validLaps(driverLaps);
    const latest = valid.at(-1) || null;
    const personalBest = valid.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0] || null;
    const currentTime = numeric(timingRow.last_lap_duration) ?? numeric(latest?.lap_duration);
    const personalTime = numeric(timingRow.best_lap_duration) ?? numeric(personalBest?.lap_duration);
    const currentColor = currentTime === null ? "gray" : currentTime === sessionBest ? "purple" : currentTime === personalTime ? "green" : "yellow";
    const bestColor = personalTime === null ? "gray" : personalTime === sessionBest ? "purple" : "green";
    extra.last_lap_time[key] = currentTime === null ? "" : formatBackendTime(currentTime);
    extra.last_lap_time_color[key] = currentColor;
    extra.best_lap_time_color[key] = bestColor;
    extra.sectors[key] = [1, 2, 3].map((sector) => {
      const current = numeric(timingRow[`duration_sector_${sector}`]) ?? numeric(latest?.[`duration_sector_${sector}`]);
      const best = valid.map((lap) => numeric(lap[`duration_sector_${sector}`])).filter((value) => value !== null);
      const statsBest = numeric(bestSectorRows[sector - 1]?.Value);
      const bestValue = statsBest ?? (best.length ? Math.min(...best) : null);
      return {
        sector,
        time: current === null ? "" : current.toFixed(3),
        time_color: current === null ? "gray" : current === sessionBestSectors[sector - 1] ? "purple" : current === bestValue ? "green" : "yellow",
        best_time: bestValue === null ? "" : bestValue.toFixed(3),
        best_time_color: bestValue === null ? "gray" : bestValue === sessionBestSectors[sector - 1] ? "purple" : "green",
      };
    });
    const segmentArrays = [1, 2, 3].map((sector) => timingRow[`segments_sector_${sector}`] || latest?.[`segments_sector_${sector}`]);
    extra.mini_sectors_data[key] = segmentArrays.map((values, sectorIndex) => ({
      sector: sectorIndex + 1,
      mini_sectors: (Array.isArray(values) ? values : []).map((status, index) => ({ status: numeric(status), mini_sector: index + 1, color: colorForStatus(status) })).filter((mini) => mini.status !== null),
    }));
    const stints = stintsByCar.get(car) || [];
    extra.tire_history[key] = stints.map(mapStint);
    extra.tire_info[key] = stints.length ? mapStint(stints.at(-1)) : null;
    extra.track_limits[key] = raceControl.filter((message) => messageDriverNumber(message) === car && /TRACK LIMITS/i.test(message.message || "")).length;
  }
  const messages = raceControl.map((row) => ({
    lap: row.lap_number ?? row.lap ?? null,
    text_en: String(row.message || row.text_en || ""),
    text_zh: null,
    utc: row.utc ?? (Date.parse(row.date || "") ? Math.floor(Date.parse(row.date) / 1000) : null),
  })).filter((row) => row.text_en);
  const mappedMessages = (Array.isArray(existing?.messages) && existing.messages.length ? existing.messages : messages)
    .map((row) => {
      if (!row || typeof row !== "object") return row;
      const { text_zh, ...withoutTranslation } = row;
      return { ...withoutTranslation, text_zh: null };
    });
  const mapped = {
    id: existing?.id ?? null,
    parent_id: existing?.parent_id ?? null,
    sport_id: existing?.sport_id ?? 30,
    name: existing?.name ?? String(sessionName || "session").toLowerCase(),
    type: existing?.type ?? (RACE_SESSIONS.has(sessionName) ? "race" : "session"),
    type_id: existing?.type_id ?? null,
    status: existing?.status ?? null,
    status_specific: existing?.status_specific ?? null,
    time: existing?.time ?? null,
    start_time: existing?.start_time ?? null,
    end_time: existing?.end_time ?? null,
    winner: existing?.winner ? { ...winner, ...existing.winner } : winner,
    competitors,
    fields: {
      laps_completed: winnerLaps,
      laps: winnerLaps,
      substatus: winnerLaps !== null && competitors.length && competitors.every((row) => Number(row.laps) === winnerLaps) ? "All laps completed" : "",
      ...(existing?.fields || {}),
    },
    messages: mappedMessages,
    extra: Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, existing?.extra?.[key] ?? value])),
    mapping_version: "backend-fields-v1",
  };
  return mapped;
}
