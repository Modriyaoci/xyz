import { isCompleteLapRecord } from "./session-feed-rules.mjs";

const DRIVER_IDS = {
  ALB: 347504, LIN: 347549, SAI: 347548, LEC: 347492, OCO: 347547, ALO: 347502,
  COL: 347540, BOR: 347539, RUS: 347501, HAD: 347537, ANT: 347534, STR: 347503,
  NOR: 347506, HAM: 347542, LAW: 347514, VER: 347482, HUL: 347544, BEA: 347520,
  PIA: 347528, GAS: 347499, PER: 347519, BOT: 347525, CRA: 347908, FOR: 368438,
  HER: 368439, IWA: 347538, BEG: 347535, BRO: 347536, VES: 347526, ARO: 347543,
  MAG: 347532, RIC: 347524, ZHO: 347530, GUA: 347530, SAR: 347521, DEV: 347529,
  HIR: 347541, TSU: 347546, VET: 347471, RAI: 347469, GRO: 347438, KVY: 347472,
  GIO: 347500, KUB: 347505, LAT: 347507, AIT: 347510, FIT: 347512, MSC: 347508,
  MAZ: 347513,
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
  "luke browning": 347536, "frederik vesti": 347526, "paul aron": 347543,
  "ryo hirakawa": 347541, "yuki tsunoda": 347546,
  "kevin magnussen": 347532, "daniel ricciardo": 347524, "sebastian vettel": 347471,
  "kimi raikkonen": 347469, "kimi räikkönen": 347469, "romain grosjean": 347438,
  "daniil kvyat": 347472, "antonio giovinazzi": 347500, "robert kubica": 347505,
  "nicholas latifi": 347507, "jack aitken": 347510, "pietro fittipaldi": 347512,
  "mick schumacher": 347508, "nikita mazepin": 347513, "zhou guanyu": 347530,
  "guanyu zhou": 347530, "logan sargeant": 347521, "nyck de vries": 347529,
  "jack doohan": 347517, "antonio fuoco": 347909, "theo pourchaire": 347522,
  "felipe drugovich": 347518, "victor martins": 347545, "pato o ward": 347531,
  "alex dunne": 347550, "ma qinghua": 347462, "daniel juncadella": 347477,
  "susie wolff": 347479, "fairuz fauzy": 347432, "jan charouz": 347457,
  "davide valsecchi": 347443, "luiz razia": 347444, "dani clos": 347467,
  "robert wickens": 347461, "antonio felix da costa": 347486, "raffaele marciello": 347488,
  "fabio leimer": 347489, "james calado": 347473, "rodolfo gonzalez": 347474,
  "cian shields": 350540, "robin frijns": 347481, "adderly fong": 347483,
  "artem markelov": 347555, "naoki yamamoto": 347556, "arthur leclerc": 347557,
  "sebastien bourdais": 347424, "anthony davidson": 347422, "takuma sato": 347421,
  "david coulthard": 347423, "nelson piquet jr": 347427, "luca badoer": 347425,
  "kazuki nakajima": 347428, "giancarlo fisichella": 347426, "christian klien": 347435,
  "sakon yamamoto": 347430, "lucas di grassi": 347429, "karun chandhok": 347436,
  "vitantonio liuzzi": 347458, "jarno trulli": 347451, "rubens barrichello": 347450,
  "sebastien buemi": 347446, "jaime alguersuari": 347442, "nick heidfeld": 347433,
  "jerome d ambrosio": 347434, "narain karthikeyan": 347449, "pedro de la rosa": 347454,
  "timo glock": 347448, "vitaly petrov": 347440, "bruno senna": 347437,
  "michael schumacher": 347453, "giedo van der garde": 347470, "heikki kovalainen": 347445,
  "charles pic": 347463, "mark webber": 347441, "andre lotterer": 347484,
  "kamui kobayashi": 347447, "max chilton": 347464, "adrian sutil": 347455,
  "jules bianchi": 347466, "jean eric vergne": 347460, "will stevens": 347476,
  "roberto merhi": 347475, "alexander rossi": 347465, "pastor maldonado": 347456,
  "roy nissany": 347511, "esteban gutierrez": 347468, "rio haryanto": 347496,
  "jordan king": 347493, "felipe nasr": 347480, "sean gelael": 347497,
  "paul di resta": 347431, "alfonso celis jr": 347491, "pascal wehrlein": 347494,
  "jolyon palmer": 347487, "felipe massa": 347439, "sergey sirotkin": 347485,
  "brendon hartley": 347498, "stoffel vandoorne": 347495, "marcus ericsson": 347478,
};

const DRIVER_IDS_BY_CAR = {
  1: 347506, 3: 347482, 5: 347539, 10: 347499, 11: 347519, 12: 347534,
  14: 347502, 16: 347492, 18: 347503, 22: 347546, 23: 347504, 25: 368439,
  27: 347544, 30: 347514, 31: 347547, 34: 347908, 38: 347535, 41: 347549,
  43: 347540, 44: 347542, 46: 347536, 50: 347541, 55: 347548, 61: 347543,
  63: 347501, 67: 368438, 72: 347526, 77: 347525, 81: 347528, 87: 347520,
  90: 347538,
};

const TEAM_IDS = {
  "alfa romeo": 385368, alphatauri: 385363, "scuderia toro rosso": 385363, alpine: 385366, "aston martin": 385362, "force india": 385362, audi: 394048, cadillac: 390378,
  ferrari: 385364, haas: 385361, "haas f1 team": 385361, "kick sauber": 385368, sauber: 385368, mclaren: 385367, mercedes: 385358, renault: 385366, "racing point": 385362,
  rb: 385363, "racing bulls": 385363, "red bull racing": 385355, williams: 385365,
};

// These historical names end with a current constructor or engine sponsor.
// Do not let suffix matching assign them the wrong modern team ID.
const UNMAPPED_HISTORICAL_TEAMS = new Set([
]);

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
  const aliases = Object.entries(map).sort(([left], [right]) => right.length - left.length);
  const prefix = aliases.find(([alias]) => key.startsWith(`${alias} `));
  if (prefix) return Number(prefix[1]);
  const suffix = aliases.find(([alias]) => key.endsWith(` ${alias}`));
  if (suffix) return Number(suffix[1]);
  const legacy = aliases.find(([alias]) => alias.endsWith(` ${key}`));
  if (legacy) return Number(legacy[1]);
  return null;
}

export function resolveBackendDriverId(driver) {
  const acronym = String(driver?.name_acronym || driver?.code || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DRIVER_IDS, acronym)) return Number(DRIVER_IDS[acronym]);
  const fullName = driver?.full_name || `${driver?.first_name || ""} ${driver?.last_name || ""}`;
  return lookup(DRIVER_IDS_BY_NAME, fullName) ?? DRIVER_IDS_BY_CAR[Number(driver?.driver_number)] ?? null;
}

export function resolveBackendTeamId(team) {
  const key = identityKey(team);
  if (UNMAPPED_HISTORICAL_TEAMS.has(key)) return null;
  return lookup(TEAM_IDS, key);
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
  return sortedLaps(rows).filter((lap) => isCompleteLapRecord(lap) && !lap.is_pit_out_lap);
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
  if (raw?.is_result_missing) return null;
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

// The upstream feed uses id/team_id/pitstop. The application contract uses the
// backend names below, so old cached mapped rows are normalised at the boundary.
function normalizeBackendCompetitor(row) {
  if (!row || typeof row !== "object") return row;
  const {
    id: sourceDriverId,
    team_id: sourceTeamId,
    pitstop: sourcePitstopCount,
    backend_driver_id: legacyBackendDriverId,
    backend_team_id: legacyBackendTeamId,
    grid: _sourceGrid,
    laps_led: _sourceLapsLed,
    ...rest
  } = row;
  const normalized = { ...rest };
  const driverId = row._id ?? legacyBackendDriverId ?? sourceDriverId;
  const teamId = row.teamuid ?? legacyBackendTeamId ?? sourceTeamId;
  const pitstopCount = row.pitstop_count ?? sourcePitstopCount;
  if (driverId !== null && driverId !== undefined && driverId !== "") normalized._id = driverId;
  if (teamId !== null && teamId !== undefined && teamId !== "") normalized.teamuid = teamId;
  if (pitstopCount !== null && pitstopCount !== undefined && pitstopCount !== "") normalized.pitstop_count = pitstopCount;
  return normalized;
}

function mergeByCar(generated, existing) {
  const existingByCar = new Map((Array.isArray(existing) ? existing : []).map((row) => [Number(row?.car_number), normalizeBackendCompetitor(row)]));
  const cars = new Set([...generated.map((row) => Number(row.car_number)), ...existingByCar.keys()]);
  return Array.from(cars).filter(Number.isFinite).sort((a, b) => {
    const left = generated.find((row) => Number(row.car_number) === a)?.position;
    const right = generated.find((row) => Number(row.car_number) === b)?.position;
    return (numeric(left) ?? 999) - (numeric(right) ?? 999) || a - b;
  }).map((car) => {
    const generatedRow = generated.find((row) => Number(row.car_number) === car) || { car_number: car };
    const existingRow = existingByCar.get(car) || {};
    const merged = { ...generatedRow, ...existingRow };
    // A newly fetched pit feed must replace stale zeroes retained in mapped snapshots.
    if (Object.prototype.hasOwnProperty.call(generatedRow, "pitstop_count")) merged.pitstop_count = generatedRow.pitstop_count;
    return merged;
  });
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
  const telemetrySessionBestSectors = [0, 1, 2].map((sectorIndex) => {
    const values = Object.entries(timingStatsLines)
      .filter(([key, line]) => key !== "_kf" && line && typeof line === "object")
      .map(([, line]) => numeric(Array.isArray(line.BestSectors) ? line.BestSectors[sectorIndex]?.Value : null))
      .filter((value) => value !== null);
    return values.length ? Math.min(...values) : null;
  });
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
  const fastF1Race = String(source.data_source || source.source_session || "").toLowerCase() === "fastf1" && RACE_SESSIONS.has(sessionName);
  const cars = new Set([...drivers.keys(), ...resultByCar.keys(), ...positions.keys(), ...intervals.keys(), ...lapsByCar.keys()]);
  const generatedCompetitors = Array.from(cars).filter(Number.isFinite).map((car) => {
    const driver = drivers.get(car) || {};
    const raw = resultByCar.get(car) || {};
    const position = numeric(raw.position) ?? numeric(positions.get(car)?.position);
    const lapRows = validLaps(lapsByCar.get(car) || []);
    const bestLap = lapRows.slice().sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0] || null;
    const duration = phaseValue(raw.duration);
    const laps = numeric(raw.number_of_laps) ?? (lapRows.length ? Math.max(...lapRows.map((lap) => Number(lap.lap_number) || 0)) : null);
    const intervalRow = intervals.get(car) || {};
    // Older FastF1 caches stored the non-winner race `Time` in duration and
    // left gap_to_leader empty. FastF1 defines that value as the cumulative
    // gap to the winner, so recover it here while retaining source isolation.
    const sourceGap = phaseValue(raw.gap_to_leader) ?? intervalRow.gap_to_leader;
    const lapDeficit = fastF1Race && position !== null && !raw.dns && !raw.dsq && winnerLaps !== null && laps !== null && winnerLaps > laps
      ? `${Math.max(1, Math.round(winnerLaps - laps))}L`
      : null;
    const gapRaw = sourceGap ?? (fastF1Race && position !== 1 ? duration ?? lapDeficit : null);
    const gap = position === 1 ? "" : formatBackendGap(gapRaw, { blankZero: true });
    const race = RACE_SESSIONS.has(sessionName);
    const timeValue = raw.dnf || raw.dns || raw.dsq
      ? ""
      : race && position !== 1
        ? (gap || formatBackendTime(duration))
        : formatBackendTime(duration);
    const positionDesc = race && !raw.dns && !raw.dsq && ncThreshold !== null && laps !== null && laps < ncThreshold ? "NC" : "";
    const backendDriverId = resolveBackendDriverId(driver);
    const backendTeamId = resolveBackendTeamId(driver.team_name);
    const status = statusCode(raw, sessionEnded);
    const competitor = {
      ...(backendDriverId == null ? {} : { _id: backendDriverId }),
      ...(backendTeamId == null ? {} : { teamuid: backendTeamId }),
      ...(position == null ? {} : { position }),
      ...(laps == null ? {} : { laps }),
      time: { value: timeValue },
      ...(status == null ? {} : { status }),
      interval: formatBackendGap(intervalRow.interval, { blankZero: true }),
      gap_to_leader: gap,
      pitstop_count: pitsByCar.get(car) || 0,
      fastest_lap_time: bestLap ? formatBackendTime(bestLap.lap_duration) : "",
      car_number: car,
      position_desc: positionDesc,
    };
    if (raw.points !== undefined && raw.points !== null) competitor.points = raw.points;
    return competitor;
  });
  const competitors = mergeByCar(generatedCompetitors, existing?.competitors);
  for (const competitor of competitors) {
    if (resultByCar.get(Number(competitor.car_number))?.is_result_missing) delete competitor.status;
  }
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
    const hasLastLapFlags = typeof timingRow.last_lap_overall_fastest === "boolean" || typeof timingRow.last_lap_personal_fastest === "boolean";
    const currentColor = currentTime === null
      ? "gray"
      : hasLastLapFlags
        ? timingRow.last_lap_overall_fastest === true
          ? "purple"
          : timingRow.last_lap_personal_fastest === true ? "green" : "yellow"
        : currentTime === sessionBest ? "purple" : currentTime === personalTime ? "green" : "yellow";
    const bestColor = personalTime === null ? "gray" : personalTime === sessionBest ? "purple" : "green";
    extra.last_lap_time[key] = currentTime === null ? "" : formatBackendTime(currentTime);
    extra.last_lap_time_color[key] = currentColor;
    extra.best_lap_time_color[key] = bestColor;
    extra.sectors[key] = [1, 2, 3].map((sector) => {
      const current = numeric(timingRow[`duration_sector_${sector}`]) ?? numeric(latest?.[`duration_sector_${sector}`]);
      const best = valid.map((lap) => numeric(lap[`duration_sector_${sector}`])).filter((value) => value !== null);
      const statsBest = numeric(bestSectorRows[sector - 1]?.Value);
      const bestValue = statsBest ?? (best.length ? Math.min(...best) : null);
      const overallBest = telemetrySessionBestSectors[sector - 1] ?? sessionBestSectors[sector - 1];
      const usesCurrentValue = timingRow[`duration_sector_${sector}_source`] === "current";
      const overallFastest = timingRow[`sector_${sector}_overall_fastest`];
      const personalFastest = timingRow[`sector_${sector}_personal_fastest`];
      const hasCurrentFlags = usesCurrentValue && (typeof overallFastest === "boolean" || typeof personalFastest === "boolean");
      const timeColor = current === null
        ? "gray"
        : hasCurrentFlags
          ? overallFastest === true ? "purple" : personalFastest === true ? "green" : "yellow"
          : current === overallBest ? "purple" : current === bestValue ? "green" : "yellow";
      const statsPosition = numeric(bestSectorRows[sector - 1]?.Position);
      return {
        sector,
        time: current === null ? "" : current.toFixed(3),
        time_color: timeColor,
        best_time: bestValue === null ? "" : bestValue.toFixed(3),
        best_time_color: bestValue === null ? "gray" : statsPosition === 1 || bestValue === overallBest ? "purple" : "green",
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
    text_zh: row.text_zh ?? null,
    utc: row.utc ?? (Date.parse(row.date || "") ? Math.floor(Date.parse(row.date) / 1000) : null),
  })).filter((row) => row.text_en);
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
    winner: existing?.winner ? { ...winner, ...normalizeBackendCompetitor(existing.winner) } : winner,
    competitors,
    fields: {
      laps_completed: winnerLaps,
      laps: winnerLaps,
      substatus: winnerLaps !== null && competitors.length && competitors.every((row) => Number(row.laps) === winnerLaps) ? "All laps completed" : "",
      ...(existing?.fields || {}),
    },
    messages: Array.isArray(existing?.messages) && existing.messages.length ? existing.messages : messages,
    extra: Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, existing?.extra?.[key] ?? value])),
    mapping_version: "backend-fields-v2",
  };
  return mapped;
}
