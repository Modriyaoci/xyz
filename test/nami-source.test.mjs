import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode } from "@msgpack/msgpack";
import {
  DEFAULT_NANA_MAPPING,
  normaliseNanaSnapshot,
  normaliseNanaWeather,
  timestampIso,
  timestampMs,
} from "../nana-mapping.mjs";
import {
  NAMI_STAGES,
  decodeNamiData,
  fetchNamiSnapshot,
  namiLiveTargetAt,
  namiMeetingRows,
  namiSessionData,
  namiSessionRows,
} from "../nami-source.mjs";

const snapshot = {
  id: 103697,
  parent_id: 103689,
  sport_id: 30,
  name: "race",
  type: "race",
  status: 100,
  time: 1788423927,
  winner: { id: 347506, team_id: 385367, laps: 72, time: { value: "2:04:45.099" }, position: 1, car_number: 1 },
  fields: { laps: 72, laps_completed: 72 },
  competitors: [
    { id: 347506, team_id: 385367, laps: 72, time: { value: "2:04:45.099" }, points: 25, status: 302, interval: "", position: 1, gap_to_leader: "", pitstop: 3, fastest_lap_time: "1:14.321", car_number: 1 },
    { id: 347482, team_id: 385355, laps: 71, time: { value: "+32.677" }, points: 18, status: 302, interval: "+32.677", position: 2, gap_to_leader: "1L", pitstop: 2, fastest_lap_time: "1:14.500", car_number: 3 },
  ],
  messages: [{ lap: 1, text_en: "SESSION STARTED", text_zh: "比赛开始", utc: 1787487126 }],
  extra: {
    last_lap_time: { 347506: "1:15.265", 347482: "1:16.154" },
    last_lap_time_color: { 347506: "yellow", 347482: "green" },
    best_lap_time_color: { 347506: "purple", 347482: "green" },
    sectors: { 347506: [{ sector: 1, time: "25.477", time_color: "yellow", best_time: "25.267", best_time_color: "purple" }] },
    mini_sectors: { 347506: [{ sector: 1, mini_sectors: [{ mini_sector: 1, status: 2051, color: "purple" }] }] },
    tire_history: { 347506: [{ compound: "MEDIUM", total_laps: 2 }, { compound: "SOFT", total_laps: 19 }, { compound: "HARD", total_laps: 26 }] },
    tire_info: { 347506: { compound: "HARD", total_laps: 25 } },
    track_limits: { 347506: 1 },
  },
};

test("decodes the Base64 MessagePack payload", () => {
  const encoded = Buffer.from(encode(snapshot)).toString("base64");
  assert.deepEqual(decodeNamiData(encoded), snapshot);
});

test("requests only the selected provider's latest snapshot for the schedule", async () => {
  const encoded = Buffer.from(encode(snapshot)).toString("base64");
  let requestedUrl;
  const result = await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "dash",
    stageId: 103697,
    live: false,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => [{ time: "2026-09-03 17:53:32", data: encoded }] };
    },
  });
  assert.equal(requestedUrl.searchParams.get("pid"), "138");
  assert.equal(requestedUrl.searchParams.get("live"), "1");
  assert.equal(requestedUrl.searchParams.get("nm"), null);
  assert.equal(requestedUrl.searchParams.get("stage_id"), "103697");
  assert.equal(result.recordTimeIso, "2026-09-03T09:53:32.000Z");
  await assert.rejects(() => fetchNamiSnapshot({ token: "x", provider: "dash", stageId: 999, fetchImpl: async () => null }), /不在.*目录/);
});

test("falls back to the Nami node cache when a qualifying phase has no provider record", async () => {
  const phaseSnapshot = {
    id: 103725,
    parent_id: 103710,
    type: "qualificationpart",
    competitors: [{ id: 347499, team_id: 385366, position: 1, laps: 6, status: 302, fastest_lap_time: "1:22.612" }],
  };
  const encoded = Buffer.from(encode(phaseSnapshot)).toString("base64");
  const requestedUrls = [];
  const result = await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "dash",
    stageId: 103725,
    live: true,
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      return {
        ok: true,
        status: 200,
        json: async () => requestedUrls.length === 1 ? {} : [{ time: "", data: encoded }],
      };
    },
  });
  assert.equal(requestedUrls[0].searchParams.get("pid"), "138");
  assert.equal(requestedUrls[0].searchParams.get("live"), "1");
  assert.equal(requestedUrls[1].searchParams.get("pid"), "103");
  assert.equal(requestedUrls[1].searchParams.get("nm"), "1");
  assert.equal(result.fallback, "nami-cache");
  assert.equal(result.upstreamPid, 103);
  assert.match(result.recordVersion, /^[a-f0-9]{64}$/);
});

test("uses the more complete Nami cache after a qualifying phase ends", async () => {
  const incomplete = Buffer.from(encode({
    id: 103726,
    type: "qualification",
    competitors: [{ id: 347520, position: 12, fastest_lap_time: "1:22.756" }],
  })).toString("base64");
  const complete = Buffer.from(encode({
    id: 103726,
    type: "qualificationpart",
    winner: { id: 347534, position: 1, fastest_lap_time: "1:21.882" },
    competitors: Array.from({ length: 16 }, (_, index) => ({
      id: index === 0 ? 347534 : 400000 + index,
      position: index + 1,
      fastest_lap_time: `1:2${index}.000`,
    })),
  })).toString("base64");
  const requestedUrls = [];
  const result = await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "official",
    stageId: 103726,
    live: true,
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      return { ok: true, status: 200, json: async () => [{ data: requestedUrls.length === 1 ? incomplete : complete }] };
    },
  });
  assert.equal(requestedUrls.length, 2);
  assert.equal(result.fallback, "nami-cache");
  assert.equal(result.data.competitors.length, 16);
});

test("clears Q2 timing remnants for positions 17-22", () => {
  const cars = Object.keys(DEFAULT_NANA_MAPPING.cars).slice(0, 22).map(Number);
  const competitors = cars.map((car, index) => ({
    car_number: car,
    position: index + 1,
    laps: 5,
    status: 302,
    fastest_lap_time: `1:${String(20 + index).padStart(2, "0")}.000`,
    time: { value: `1:${String(20 + index).padStart(2, "0")}.000` },
    gap_to_leader: index ? `+${index}.000` : "",
    interval: index ? "+1.000" : "",
    last_lap_time: "1:24.000",
    last_lap_time_color: "yellow",
    best_lap_time_color: "green",
    sectors: [{ sector: 1, time: "28.000", time_color: "yellow" }],
    mini_sectors: [{ sector: 1, mini_sectors: [{ mini_sector: 1, status: 2048, color: "yellow" }] }],
    tire_history: [{ compound: "SOFT", total_laps: 5 }],
    track_limits: 2,
  }));
  const data = namiSessionData({
    id: 103726,
    parent_id: 103710,
    type: "qualificationpart",
    time: 0,
    start_time: 0,
    end_time: 0,
    competitors,
    extra: {
      last_lap_time: Object.fromEntries(cars.map((car) => [car, "1:24.000"])),
      last_lap_time_color: Object.fromEntries(cars.map((car) => [car, "yellow"])),
      best_lap_time_color: Object.fromEntries(cars.map((car) => [car, "green"])),
      sectors: Object.fromEntries(cars.map((car) => [car, [{ sector: 1, time: "28.000", time_color: "yellow" }]])),
      mini_sectors: Object.fromEntries(cars.map((car) => [car, [{ sector: 1, mini_sectors: [{ mini_sector: 1, status: 2048 }] }]])),
      tire_info: Object.fromEntries(cars.map((car) => [car, { compound: "SOFT", total_laps: 5 }])),
      tire_history: Object.fromEntries(cars.map((car) => [car, [{ compound: "SOFT", total_laps: 5 }]])),
      track_limits: Object.fromEntries(cars.map((car) => [car, 2])),
    },
  }, DEFAULT_NANA_MAPPING, { provider: "dash", stageId: 103726 });

  assert.equal(data.session_result.filter((row) => !row.is_result_missing).length, 16);
  assert.equal(data.session_result.filter((row) => row.is_result_missing).length, 6);
  const excludedResult = data.session_result.find((row) => row.position === 17);
  assert.equal(excludedResult.number_of_laps, null);
  assert.equal(excludedResult.duration, null);
  assert.equal(excludedResult.gap_to_leader, null);
  assert.equal(excludedResult.dnf, false);
  assert.equal(excludedResult.dns, false);
  assert.equal(excludedResult.dsq, false);
  const excluded = data.mapped.competitors.find((row) => row.position === 17);
  const key = String(excluded._id);
  assert.equal(excluded.status, null);
  assert.equal(excluded.laps, null);
  assert.equal(excluded.fastest_lap_time, "");
  assert.equal(excluded.time, null);
  assert.equal(excluded.interval, null);
  assert.equal(excluded.gap_to_leader, null);
  assert.deepEqual(excluded.sectors, []);
  assert.deepEqual(excluded.mini_sectors, []);
  assert.equal(data.mapped.extra.last_lap_time[key], "");
  assert.equal(data.mapped.extra.last_lap_time_color[key], "");
  assert.equal(data.mapped.extra.best_lap_time_color[key], "");
  assert.deepEqual(data.mapped.extra.sectors[key], []);
  assert.deepEqual(data.mapped.extra.mini_sectors[key], []);
  assert.deepEqual(data.mapped.extra.tire_history[key], []);
  assert.equal(data.mapped.extra.tire_info[key], null);
  assert.equal(data.mapped.extra.track_limits[key], 0);
  assert.equal(data.laps.some((row) => row.driver_number === excluded.car_number), false);
  assert.equal(data.stints.some((row) => row.driver_number === excluded.car_number), false);
  assert.equal(data.weather.length, 0);
  assert.equal(data.mapped.start_time_utc, null);
  assert.equal(data.mapped.end_time_utc, null);
});

test("marks zero-position Q2 rows as missing instead of treating their array index as a result", () => {
  const data = namiSessionData({
    id: 103726,
    competitors: [
      { car_number: 1, position: 0, laps: 4, fastest_lap_time: "1:21.000", status: 302 },
      { car_number: 3, position: 2, laps: 4, fastest_lap_time: "1:21.100", status: 302 },
    ],
  }, DEFAULT_NANA_MAPPING, { provider: "official", stageId: 103726 });
  assert.equal(data.session_result[0].is_result_missing, true);
  assert.equal(data.session_result[0].duration, null);
  assert.equal(data.session_result[1].is_result_missing, false);
});

test("replaces a stale Q3 snapshot with a newer final snapshot from the same provider parent", async () => {
  const rows = (winner, winnerTime) => Array.from({ length: 22 }, (_, index) => ({
    id: index === 0 ? winner : 500000 + index,
    position: index + 1,
    laps: 5,
    status: 302,
    fastest_lap_time: index === 0 ? winnerTime : index < 10 ? `1:22.${String(index).padStart(3, "0")}` : "1:24.000",
  }));
  const stale = Buffer.from(encode({
    id: 103727,
    parent_id: 103710,
    type: "qualificationpart",
    competitors: rows(347501, "1:21.929"),
  })).toString("base64");
  const final = Buffer.from(encode({
    id: 103710,
    parent_id: 103698,
    type: "qualification",
    competitors: rows(347499, "1:21.786"),
  })).toString("base64");
  const requestedUrls = [];
  const result = await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "dash",
    stageId: 103727,
    live: true,
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      const parent = url.searchParams.get("stage_id") === "103710";
      return {
        ok: true,
        status: 200,
        json: async () => [{ time: parent ? "2026-09-05 23:04:14" : "2026-09-05 23:00:43", data: parent ? final : stale }],
      };
    },
  });
  assert.deepEqual(requestedUrls.map((url) => url.searchParams.get("pid")), ["138", "138"]);
  assert.deepEqual(requestedUrls.map((url) => url.searchParams.get("stage_id")), ["103727", "103710"]);
  assert.equal(requestedUrls.some((url) => url.searchParams.get("pid") === "103"), false);
  assert.equal(result.fallback, "provider-parent");
  assert.equal(result.upstreamPid, 138);
  assert.equal(result.fallbackStageId, 103710);
  assert.equal(result.validatedAgainstStageId, 103710);
  assert.equal(result.data.id, 103727);
  assert.equal(result.data.competitors[0].id, 347499);
  assert.equal(result.data.competitors[0].fastest_lap_time, "1:21.786");

  const data = namiSessionData(result.data, DEFAULT_NANA_MAPPING, { provider: "dash", stageId: 103727 });
  assert.equal(data.session_result.filter((row) => !row.is_result_missing).length, 10);
  assert.equal(data.session_result.filter((row) => row.is_result_missing).length, 12);
  assert.equal(data.session_result.find((row) => row.position === 11).duration, null);
});

test("does not use a parent overall table as Q2 phase data", async () => {
  const phaseRows = Array.from({ length: 22 }, (_, index) => ({
    id: 600000 + index,
    position: index + 1,
    fastest_lap_time: index < 16 ? `1:22.${String(index).padStart(3, "0")}` : "1:25.000",
  }));
  const parentRows = phaseRows.map((row, index) => ({ ...row, fastest_lap_time: index < 10 ? `1:20.${String(index).padStart(3, "0")}` : row.fastest_lap_time }));
  const phase = Buffer.from(encode({ id: 103726, parent_id: 103710, competitors: phaseRows })).toString("base64");
  const parent = Buffer.from(encode({ id: 103710, competitors: parentRows })).toString("base64");
  const requestedUrls = [];
  const result = await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "radar",
    stageId: 103726,
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      const isParent = url.searchParams.get("stage_id") === "103710";
      return { ok: true, status: 200, json: async () => [{ time: isParent ? "2026-09-05 23:05:00" : "2026-09-05 22:45:00", data: isParent ? parent : phase }] };
    },
  });
  assert.equal(requestedUrls.length, 2);
  assert.deepEqual(requestedUrls.map((url) => url.searchParams.get("pid")), ["84", "84"]);
  assert.equal(result.fallback, null);
  assert.equal(result.data.competitors[0].fastest_lap_time, "1:22.000");
});

test("does not invent weather or epoch dates for empty Nami fields", () => {
  assert.deepEqual(normaliseNanaWeather(undefined, 1788423927), {});
  assert.deepEqual(normaliseNanaWeather({}, 1788423927), {});
  assert.equal(timestampMs(0), null);
  assert.equal(timestampMs("0"), null);
  assert.equal(timestampIso(0), null);
  assert.equal(timestampIso("0"), null);
  const mapped = normaliseNanaSnapshot({ time: 1788423927, start_time: 0, end_time: 0, competitors: [] });
  assert.deepEqual(mapped.extra.weather, {});
  assert.deepEqual(mapped.extra.weather_records, []);
  assert.equal(mapped.start_time_utc, null);
  assert.equal(mapped.end_time_utc, null);
});

test("keeps live provider requests independent", async () => {
  const encoded = Buffer.from(encode(snapshot)).toString("base64");
  let requestedUrl;
  await fetchNamiSnapshot({
    token: "server-only-token",
    provider: "dash",
    stageId: 103697,
    live: true,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => [{ time: "2026-09-03 17:53:32", data: encoded }] };
    },
  });
  assert.equal(requestedUrl.searchParams.get("pid"), "138");
  assert.equal(requestedUrl.searchParams.get("live"), "1");
  assert.equal(requestedUrl.searchParams.get("nm"), null);
  assert.equal(requestedUrl.searchParams.get("stage_id"), "103697");
});

test("converts the Dutch race snapshot to the schedule contract", () => {
  const data = namiSessionData(snapshot, DEFAULT_NANA_MAPPING, {
    provider: "dash",
    stageId: 103697,
    recordCount: 4,
    recordTime: "2026-09-03 17:53:32",
    recordTimeIso: "2026-09-03T09:53:32.000Z",
  });
  assert.equal(data.data_source, "nami");
  assert.equal(data.session.session_key, 103697);
  assert.equal(data.nami.provider, "dash");
  assert.equal(data.nami.record_count, 4);
  assert.equal(data.drivers[0].full_name, "Lando Norris");
  assert.equal(data.mapped.competitors[0]._id, 347506);
  assert.equal(data.mapped.competitors[0].teamuid, 385367);
  assert.equal(data.session_result[0].duration, 7485.099);
  assert.equal(data.session_result[1].gap_to_leader, "1L");
  assert.equal(data.intervals[1].gap_to_leader, "1L");
  assert.equal(data.mapped.extra.best_lap_time_color["347506"], "purple");
  assert.equal(data.mapped.extra.mini_sectors["347506"][0].mini_sectors[0].color, "purple");
  assert.equal(data.race_control[0].date, "2026-08-23T12:12:06.000Z");
  assert.equal(data.stints.length, 4);
  assert.equal(data.pit.filter((row) => row.driver_number === 1).length, 3);
});

test("keeps missing timing colours gray instead of treating them as status zero", () => {
  const data = namiSessionData({ ...snapshot, extra: {} }, DEFAULT_NANA_MAPPING, { provider: "radar", stageId: 103697 });
  assert.equal(data.mapped.extra.last_lap_time_color["347506"], "gray");
  assert.equal(data.mapped.extra.best_lap_time_color["347506"], "gray");
});

test("maps qualifying rows without car numbers by backend driver id", () => {
  const phaseSnapshot = {
    id: 103725,
    parent_id: 103710,
    type: "qualificationpart",
    competitors: [
      { id: 347499, team_id: 385366, position: 1, laps: 6, status: 302, fastest_lap_time: "1:22.612" },
      { id: 347501, team_id: 385358, position: 2, laps: 6, status: 302, fastest_lap_time: "1:22.700" },
    ],
  };
  const data = namiSessionData(phaseSnapshot, DEFAULT_NANA_MAPPING, { provider: "radar", stageId: 103725 });
  assert.deepEqual(data.drivers.map((row) => row.driver_number), [10, 63]);
  assert.equal(data.session_result[0].duration, 82.612);
  assert.equal(data.session_result[1].duration, 82.7);
  assert.equal(data.mapped.competitors[0].name, "Pierre Gasly");
});

test("selects the requested phase when Q1 Q2 and Q3 arrive in one payload", () => {
  const combined = normaliseNanaSnapshot({
    type: "qualification",
    competitors: [{ car_number: 3, position: 1, fastest_lap_time: "1:20.000" }],
    extra: {
      leaderboard_q1_data: [{ id: 347499, position: 1, fastest_lap_time: "1:22.612" }],
      leaderboard_q2_data: [{ id: 347501, position: 1, fastest_lap_time: "1:21.882" }],
      leaderboard_q3_data: [{ id: 347482, position: 1, fastest_lap_time: "1:20.999" }],
    },
  }, DEFAULT_NANA_MAPPING, { sessionPhase: "q2" });
  assert.equal(combined.competitors[0].car_number, 63);
  assert.equal(combined.competitors[0].fastest_lap_time, "1:21.882");
  assert.equal(combined.winner.car_number, 63);
  assert.equal(combined.extra.leaderboard_q1_data[0].car_number, 10);
  assert.equal(combined.extra.leaderboard_q3_data[0].car_number, 3);
});

test("includes every supplied reserve-driver car mapping", () => {
  const expected = {
    25: ["Colton Herta", 368439, "Cadillac", 390378],
    34: ["Jak Crawford", 347908, "Aston Martin", 385362],
    38: ["Dino Beganovic", 347535, "Ferrari", 385364],
    46: ["Luke Browning", 347536, "Williams", 385365],
    50: ["Ryo Hirakawa", 347541, "Haas F1 Team", 385361],
    61: ["Paul Aron", 347543, "Alpine", 385366],
    67: ["Leonardo Fornaroli", 368438, "McLaren", 385367],
    72: ["Frederik Vesti", 347526, "Mercedes", 385358],
    90: ["Ayumu Iwasa", 347538, "Red Bull Racing", 385355],
  };
  for (const [car, [driverName, driverId, teamName, teamId]] of Object.entries(expected)) {
    const row = DEFAULT_NANA_MAPPING.cars[car];
    assert.equal(row.driver_name, driverName);
    assert.equal(row.driver_id, driverId);
    assert.equal(row.team_name, teamName);
    assert.equal(row.team_id, teamId);
  }
});

test("exposes all 2026 meetings and stage ids from the supplied workbook", () => {
  const meetings = namiMeetingRows(2026);
  assert.equal(meetings.length, 24);
  assert.equal(meetings[0].meeting_key, 103563);
  assert.equal(meetings[0].season_id, 103557);
  assert.equal(Object.keys(NAMI_STAGES).length, 210);
  assert.deepEqual(namiSessionRows(103563).map((row) => row.stage_id), [103569, 103570, 103571, 103572, 103600, 103601, 103602, 103573]);
  assert.deepEqual(namiSessionRows(103689).map((row) => row.session_name), ["Practice 1", "Sprint Qualifying", "Sprint Qualifying Q1", "Sprint Qualifying Q2", "Sprint Qualifying Q3", "Sprint", "Qualifying", "Qualifying Q1", "Qualifying Q2", "Qualifying Q3", "Race"]);
  assert.equal(namiSessionRows(103689).at(-1).stage_id, 103697);
  assert.equal(namiSessionRows(103689).at(-1).season_id, 103557);
});

test("selects the nearest Nami node and only polls around a live session", () => {
  const fridayWake = namiLiveTargetAt("2026-09-04T02:57:00.000Z");
  assert.equal(fridayWake.stage_id, 103707);
  assert.equal(fridayWake.auto_state, "next");
  assert.equal(fridayWake.polling, false);

  const prestart = namiLiveTargetAt("2026-09-04T10:20:00.000Z");
  assert.equal(prestart.stage_id, 103707);
  assert.equal(prestart.auto_state, "prestart");
  assert.equal(prestart.polling, true);

  const live = namiLiveTargetAt("2026-09-04T10:57:00.000Z");
  assert.equal(live.stage_id, 103707);
  assert.equal(live.auto_state, "active");
  assert.equal(live.polling, true);

  const nearerPrevious = namiLiveTargetAt("2026-09-04T12:20:00.000Z");
  assert.equal(nearerPrevious.stage_id, 103707);
  assert.equal(nearerPrevious.auto_state, "previous");
  assert.equal(nearerPrevious.polling, false);

  const nearerNext = namiLiveTargetAt("2026-09-04T13:10:00.000Z");
  assert.equal(nearerNext.stage_id, 103708);
  assert.equal(nearerNext.auto_state, "next");
  assert.equal(nearerNext.polling, false);

  const qualifying = namiLiveTargetAt("2026-09-05T14:10:00.000Z");
  assert.equal(qualifying.stage_id, 103710);
  assert.equal(qualifying.session_name, "Qualifying");
  assert.equal(qualifying.session_phase, null);

  const mondayBeforeSleep = namiLiveTargetAt("2026-09-07T04:00:00.000Z");
  assert.equal(mondayBeforeSleep.stage_id, 103711);
  assert.equal(mondayBeforeSleep.auto_state, "previous");
  assert.equal(mondayBeforeSleep.polling, false);
});

test("defaults live timing to Nami Dash in both deployed site copies", () => {
  for (const file of ["../app.js", "../site/app.js"]) {
    const script = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(script, /liveTiming:\s*\{\s*source: "nami-dash"/);
    assert.match(script, /nodeMode: "auto"/);
    assert.match(script, /startNamiAutoMonitor\(\)/);
    assert.match(script, /nami\/auto/);
    assert.doesNotMatch(script, /NAMI_PROVIDERS\.map\([^)]*fetchNamiLiveSnapshot/);
  }
  for (const file of ["../index.html", "../site/index.html"]) {
    const html = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(html, /<select id="liveSourceSelect"><option value="nami-radar">纳米-雷达<\/option><option value="nami-dash" selected>纳米-dash<\/option><option value="nami-official">纳米-官方<\/option><option value="f1telemetry">F1 Telemetry<\/option><option value="nana">nana<\/option><option value="dash">dash<\/option><\/select>/);
    assert.match(html, /option value="nami-dash" selected>纳米-dash<\/option>/);
    assert.doesNotMatch(html, /option value="nana" selected/);
    assert.match(html, /id="namiModeSelect"/);
    assert.match(html, /app\.js\?v=20260908-nami-qualifying-v9/);
    assert.doesNotMatch(html, /!localServer && !window\.location\.pathname\.startsWith/);
    assert.match(html, /window\.location\.hostname\.endsWith\("\.github\.io"\)/);
  }
});

test("opens and refreshes car-number mapping for every Nami live source", () => {
  for (const file of ["../app.js", "../site/app.js"]) {
    const script = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(
      script,
      /function nanaMappingAvailable\([^)]*\)\s*\{\s*return !STATIC_MODE && Boolean\(liveBridgeSourceName\(source\) \|\| namiLiveProvider\(source\)\);\s*\}/,
    );
    assert.equal(
      (script.match(/if \(!nanaMappingAvailable\(live\.source\)/g) || []).length,
      3,
    );
    assert.match(script, /namiLiveProvider\(live\.source\)\s*\? await fetchNamiLiveSnapshot/);
  }
});

test("keeps Render on node selection and lets each page request its selected Nami source", () => {
  const script = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /startNamiAutoLivePolling/);
  assert.doesNotMatch(script, /Promise\.all\(Object\.values\(NAMI_PROVIDERS\)/);
  assert.match(script, /url\.pathname === "\/api\/public\/nami\/auto"/);
  assert.match(script, /nami_auto: namiAutoLiveStatus\(\)/);
  assert.match(script, /background_polling: false/);
});
