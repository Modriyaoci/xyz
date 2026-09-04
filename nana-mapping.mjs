import { resolveBackendDriverId, resolveBackendTeamId } from "./backend-fields.mjs";

const DEFAULT_ROWS = [
  [1, "Lando Norris", "NOR", 347506, "McLaren", 385367],
  [3, "Max Verstappen", "VER", 347482, "Red Bull Racing", 385355],
  [5, "Gabriel Bortoleto", "BOR", 347539, "Audi", 394048],
  [6, "Isack Hadjar", "HAD", 347537, "Red Bull Racing", 385355],
  [10, "Pierre Gasly", "GAS", 347499, "Alpine", 385366],
  [11, "Sergio Perez", "PER", 347519, "Cadillac", 390378],
  [12, "Kimi Antonelli", "ANT", 347534, "Mercedes", 385358],
  [14, "Fernando Alonso", "ALO", 347502, "Aston Martin", 385362],
  [16, "Charles Leclerc", "LEC", 347492, "Ferrari", 385364],
  [18, "Lance Stroll", "STR", 347503, "Aston Martin", 385362],
  [22, "Yuki Tsunoda", "TSU", 347546, "Racing Bulls", 385363],
  [23, "Alexander Albon", "ALB", 347504, "Williams", 385365],
  [27, "Nico Hulkenberg", "HUL", 347544, "Audi", 394048],
  [30, "Liam Lawson", "LAW", 347514, "Red Bull Racing", 385355],
  [31, "Esteban Ocon", "OCO", 347547, "Haas F1 Team", 385361],
  [41, "Arvid Lindblad", "LIN", 347549, "Racing Bulls", 385363],
  [43, "Franco Colapinto", "COL", 347540, "Alpine", 385366],
  [44, "Lewis Hamilton", "HAM", 347542, "Ferrari", 385364],
  [55, "Carlos Sainz", "SAI", 347548, "Williams", 385365],
  [63, "George Russell", "RUS", 347501, "Mercedes", 385358],
  [77, "Valtteri Bottas", "BOT", 347525, "Cadillac", 390378],
  [81, "Oscar Piastri", "PIA", 347528, "McLaren", 385367],
  [87, "Oliver Bearman", "BEA", 347520, "Haas F1 Team", 385361],
];

const asNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const text = (value) => value === null || value === undefined ? "" : String(value).trim();

const STATUS_COLORS = Object.freeze({ 0: "red", 2048: "yellow", 2049: "green", 2051: "purple", 2052: "gray", 2064: "blue" });
const NAMED_COLORS = new Set(["purple", "green", "yellow", "red", "blue", "gray", "grey", "orange"]);

function colour(value, status = null) {
  const raw = text(value).toLowerCase();
  if (NAMED_COLORS.has(raw)) return raw === "grey" ? "gray" : raw;
  if (status === null || status === undefined || status === "") return "gray";
  return STATUS_COLORS[Number(status)] || "gray";
}

function normaliseSectorRows(value) {
  return Array.isArray(value) ? value.map((sector) => {
    if (!sector || typeof sector !== "object") return sector;
    return {
      ...sector,
      time_color: colour(sector.time_color ?? sector.color, sector.status),
      best_time_color: colour(sector.best_time_color ?? sector.best_color, sector.best_status),
    };
  }) : value;
}

function normaliseMiniSectorRows(value) {
  return Array.isArray(value) ? value.map((sector) => {
    if (!sector || typeof sector !== "object") return sector;
    return {
      ...sector,
      mini_sectors: Array.isArray(sector.mini_sectors) ? sector.mini_sectors.map((mini) => ({
        ...mini,
        color: colour(mini?.color, mini?.status),
      })) : [],
    };
  }) : value;
}

function firstPresent(row, fields, fallback) {
  for (const field of fields) if (hasOwn(row, field)) return row[field];
  return fallback;
}

export const DEFAULT_NANA_MAPPING = Object.freeze({
  version: 1,
  based_on: "official-standings-2026",
  cars: Object.freeze(Object.fromEntries(DEFAULT_ROWS.map(([car, driverName, driverCode, driverId, teamName, teamId]) => [String(car), Object.freeze({
    car_number: car,
    driver_id: driverId,
    driver_name: driverName,
    driver_code: driverCode,
    team_id: teamId,
    team_name: teamName,
  })]))),
});

function rawCars(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cars = value.cars && typeof value.cars === "object" && !Array.isArray(value.cars) ? value.cars : value;
  return cars && typeof cars === "object" && !Array.isArray(cars) ? cars : {};
}

export function normaliseNanaMapping(value = DEFAULT_NANA_MAPPING) {
  const input = rawCars(value);
  const keys = new Set([...Object.keys(DEFAULT_NANA_MAPPING.cars), ...Object.keys(input)]);
  const cars = {};
  for (const key of keys) {
    const car = asNumber(key);
    if (car === null || car < 0 || car > 999) continue;
    const defaults = DEFAULT_NANA_MAPPING.cars[String(car)] || { car_number: car };
    const row = input[String(car)] && typeof input[String(car)] === "object" ? input[String(car)] : {};
    cars[String(car)] = {
      car_number: car,
      driver_id: asNumber(firstPresent(row, ["driver_id", "_id", "backend_driver_id"], defaults.driver_id)),
      driver_name: text(firstPresent(row, ["driver_name", "name"], defaults.driver_name)),
      driver_code: text(firstPresent(row, ["driver_code", "code", "abbr"], defaults.driver_code)).toUpperCase(),
      team_id: asNumber(firstPresent(row, ["team_id", "teamuid", "backend_team_id"], defaults.team_id)),
      team_name: text(firstPresent(row, ["team_name", "teamname", "team"], defaults.team_name)),
    };
  }
  return { version: 1, based_on: "official-standings-2026", updated_at: value?.updated_at || null, cars };
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function configuredIdentity(mapping, car) {
  const row = mapping?.cars?.[String(car)];
  return row && typeof row === "object" ? row : null;
}

function fallbackDriver(row, car) {
  return resolveBackendDriverId({
    driver_number: car,
    name_acronym: row?.abbr ?? row?.short_name ?? row?.code,
    full_name: row?.driver_name ?? row?.name,
  });
}

export function nanaIdentityFor(row, mapping = DEFAULT_NANA_MAPPING) {
  const car = asNumber(row?.car_number ?? row?.racing_number ?? row?.driver_number);
  const configured = car === null ? null : configuredIdentity(mapping, car);
  const configuredDriverId = configured && hasOwn(configured, "driver_id") ? configured.driver_id : null;
  const configuredTeamId = configured && hasOwn(configured, "team_id") ? configured.team_id : null;
  const driverId = configured
    ? configuredDriverId
    : asNumber(row?._id ?? row?.backend_driver_id ?? row?.id) ?? fallbackDriver(row, car);
  const teamId = configured
    ? configuredTeamId
    : asNumber(row?.teamuid ?? row?.backend_team_id ?? row?.team_id) ?? resolveBackendTeamId(row?.team_name ?? row?.teamname ?? row?.team);
  return {
    car,
    driverId,
    driverName: configured?.driver_name || text(row?.driver_name ?? row?.name),
    driverCode: (configured?.driver_code || text(row?.driver_code ?? row?.abbr ?? row?.short_name ?? row?.code)).toUpperCase(),
    teamId,
    teamName: configured?.team_name || text(row?.team_name ?? row?.teamname ?? row?.team),
  };
}

export function normaliseNanaCompetitor(row, mapping = DEFAULT_NANA_MAPPING) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const identity = nanaIdentityFor(row, mapping);
  const {
    id: _sourceId,
    team_id: _sourceTeamId,
    backend_driver_id: _legacyDriverId,
    backend_team_id: _legacyTeamId,
    pitstop: _sourcePitstop,
    pit_stops: _sourcePitStops,
    racing_number: _racingNumber,
    ...rest
  } = row;
  const output = { ...rest };
  if (identity.car !== null) output.car_number = identity.car;
  if (identity.driverId !== null) output._id = identity.driverId;
  else delete output._id;
  if (identity.teamId !== null) output.teamuid = identity.teamId;
  else delete output.teamuid;
  if (identity.driverName) output.name = identity.driverName;
  if (identity.driverCode) output.abbr = identity.driverCode;
  if (identity.teamName) output.teamname = identity.teamName;
  if (output.position_desc === undefined && row.position_text !== undefined) output.position_desc = row.position_text;
  if (output.last_lap_time_color !== undefined) output.last_lap_time_color = colour(output.last_lap_time_color);
  if (output.best_lap_time_color !== undefined) output.best_lap_time_color = colour(output.best_lap_time_color);
  if (Array.isArray(output.sectors)) output.sectors = normaliseSectorRows(output.sectors);
  if (Array.isArray(output.mini_sectors)) output.mini_sectors = normaliseMiniSectorRows(output.mini_sectors);
  const pitstopCount = asNumber(row.pitstop_count ?? row.pitstop ?? row.pit_stops);
  if (pitstopCount !== null) output.pitstop_count = pitstopCount;
  return output;
}

export function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
}

export function timestampIso(value) {
  const milliseconds = timestampMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function measurement(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(",", ".").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? asNumber(match[0]) : null;
}

function rainfall(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "rain", "wet"].includes(normalized)) return true;
  return measurement(value) > 0;
}

export function normaliseNanaWeather(value, date = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = {
    ...source,
    air_temperature: measurement(source.air_temperature ?? source.air_temp ?? source.air),
    track_temperature: measurement(source.track_temperature ?? source.track_temp ?? source.track),
    humidity: measurement(source.humidity),
    pressure: measurement(source.pressure),
    wind_speed: measurement(source.wind_speed ?? source.wind),
    wind_direction: measurement(source.wind_direction),
    rainfall: rainfall(source.rainfall),
  };
  const iso = timestampIso(source.date ?? source.utc ?? date);
  if (iso) output.date = iso;
  if (!output.wind_direction_abbr && output.wind_direction !== null) {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    output.wind_direction_abbr = directions[Math.round(output.wind_direction / 45) % 8];
  }
  return output;
}

export function normaliseNanaMessages(value, fallbackDate = null) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => {
    const source = row && typeof row === "object" ? row : { Message: row };
    const rawTimestamp = source.utc ?? source.Utc ?? source.timestamp ?? source.date;
    const date = timestampIso(rawTimestamp) || timestampIso(fallbackDate);
    const seconds = timestampMs(rawTimestamp);
    const message = {
      ...source,
      lap: source.lap ?? source.lap_number ?? source.Lap ?? null,
      lap_number: source.lap_number ?? source.lap ?? source.Lap ?? null,
      category: source.category ?? source.Category ?? "",
      text_en: text(source.text_en ?? source.message ?? source.Message),
      text_zh: source.text_zh ?? source.MessageZh ?? source.message_zh ?? "",
      utc: seconds === null ? null : Math.floor(seconds / 1000),
    };
    if (date) message.date = date;
    return message;
  }).filter((row) => row.text_en || row.text_zh);
}

function mapExtraByCar(source, competitors, mapping) {
  const byToken = new Map();
  const identities = new Map();
  for (const [car, configured] of Object.entries(mapping?.cars || {})) {
    const identity = {
      car_number: Number(car),
      _id: configured?.driver_id ?? null,
      abbr: configured?.driver_code || "",
      name: configured?.driver_name || "",
    };
    for (const token of [car, identity.abbr, identity.name, identity._id]) if (token !== null && token !== undefined && token !== "") identities.set(String(token).toUpperCase(), identity);
  }
  for (const row of competitors) {
    const car = row.car_number;
    const code = String(row.abbr || "").toUpperCase();
    if (car !== null && car !== undefined) byToken.set(String(car), row);
    if (code) byToken.set(code, row);
    const rawName = String(row.name || "").toUpperCase();
    if (rawName) byToken.set(rawName, row);
    for (const token of [car, code, rawName, row._id]) if (token !== null && token !== undefined && token !== "") identities.set(String(token).toUpperCase(), row);
  }
  const resolveRow = (key) => byToken.get(String(key)) || byToken.get(String(key).toUpperCase()) || identities.get(String(key).toUpperCase()) || null;
  const output = {
    last_lap_time: {},
    last_lap_time_color: {},
    best_lap_time_color: {},
    sectors: {},
    mini_sectors: {},
    mini_sectors_data: {},
    tire_info: {},
    tire_history: {},
    track_limits: {},
  };
  for (const row of competitors) {
    const id = row?._id;
    if (id === null || id === undefined) continue;
    const key = String(id);
    output.last_lap_time[key] = row.last_lap_time ?? "";
    output.last_lap_time_color[key] = colour(row.last_lap_time_color);
    output.best_lap_time_color[key] = colour(row.best_lap_time_color);
    output.sectors[key] = normaliseSectorRows(row.sectors) || [];
    output.mini_sectors[key] = normaliseMiniSectorRows(row.mini_sectors) || [];
    const history = Array.isArray(row.tire_history) ? row.tire_history : [];
    output.tire_history[key] = history;
    output.tire_info[key] = history.at(-1) || null;
    output.track_limits[key] = row.track_limits ?? 0;
  }
  const sourceExtra = source && typeof source === "object" ? source : {};
  const mini = sourceExtra.mini_sectors || sourceExtra.mini_sectors_data || {};
  if (mini && typeof mini === "object" && !Array.isArray(mini)) {
    for (const [token, value] of Object.entries(mini)) {
      const row = resolveRow(token);
      if (row?._id !== null && row?._id !== undefined) {
        const normalised = normaliseMiniSectorRows(value);
        output.mini_sectors_data[String(row._id)] = normalised;
        output.mini_sectors[String(row._id)] = normalised;
      }
    }
  }
  const tires = sourceExtra.tire_info || {};
  if (tires && typeof tires === "object" && !Array.isArray(tires)) {
    for (const [token, value] of Object.entries(tires)) {
      const row = resolveRow(token);
      if (row?._id !== null && row?._id !== undefined) output.tire_info[String(row._id)] = value;
    }
  }
  const mapFields = ["sectors", "last_lap_time", "last_lap_time_color", "best_lap_time_color", "tire_history", "track_limits"];
  for (const field of mapFields) {
    const values = sourceExtra[field];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [token, value] of Object.entries(values)) {
      const row = resolveRow(token);
      if (row?._id === null || row?._id === undefined) continue;
      const key = String(row._id);
      if (field === "sectors") output.sectors[key] = normaliseSectorRows(value);
      else if (field.endsWith("_color")) output[field][key] = colour(value);
      else if (field === "tire_history") output.tire_history[key] = Array.isArray(value) ? value : [];
      else output[field][key] = value;
    }
  }
  return output;
}

export function normaliseNanaSnapshot(value, mapping = DEFAULT_NANA_MAPPING) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const activeMapping = normaliseNanaMapping(mapping);
  const sourceExtra = source.extra && typeof source.extra === "object" && !Array.isArray(source.extra) ? source.extra : {};
  const rawCompetitors = Array.isArray(source.competitors)
    ? source.competitors
    : Array.isArray(sourceExtra.leaderboard) ? sourceExtra.leaderboard
      : Array.isArray(sourceExtra.leaderboard_overall_data) ? sourceExtra.leaderboard_overall_data : [];
  const competitors = rawCompetitors.map((row) => normaliseNanaCompetitor(row, activeMapping));
  const winnerSource = source.winner && typeof source.winner === "object" ? source.winner : competitors.find((row) => Number(row.position) === 1);
  const eventTime = timestampIso(source.time);
  const startTime = timestampIso(source.start_time);
  const endTime = timestampIso(source.end_time);
  const weather = normaliseNanaWeather(sourceExtra.weather, source.time);
  const messages = normaliseNanaMessages(source.messages || sourceExtra.race_control_messages, source.time);
  const winner = winnerSource ? normaliseNanaCompetitor(winnerSource, activeMapping) : null;
  const extra = {
    ...sourceExtra,
    weather,
    weather_records: Object.keys(weather).length ? [weather] : [],
    race_control_messages: messages,
    ...mapExtraByCar(sourceExtra, competitors, activeMapping),
  };
  for (const key of ["leaderboard", "leaderboard_overall_data", "leaderboard_q1_data", "leaderboard_q2_data", "leaderboard_q3_data"]) {
    if (Array.isArray(sourceExtra[key])) extra[key] = sourceExtra[key].map((row) => normaliseNanaCompetitor(row, activeMapping));
  }
  return {
    ...source,
    time_utc: eventTime,
    start_time_utc: startTime,
    end_time_utc: endTime,
    event_time_utc: eventTime,
    winner,
    team_winner: source.team_winner && typeof source.team_winner === "object"
      ? { ...source.team_winner, teamuid: winner?.teamuid ?? source.team_winner.teamuid ?? source.team_winner.team_id ?? null, team_id: winner?.teamuid ?? source.team_winner.team_id ?? null }
      : source.team_winner ?? null,
    competitors,
    fields: { ...(source.fields && typeof source.fields === "object" ? source.fields : {}), ...(sourceExtra.lap_info || {}) },
    messages,
    extra,
    nana_mapping_version: activeMapping.version,
  };
}
