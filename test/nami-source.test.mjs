import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "@msgpack/msgpack";
import { DEFAULT_NANA_MAPPING } from "../nana-mapping.mjs";
import {
  NAMI_STAGES,
  decodeNamiData,
  fetchNamiSnapshot,
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

test("requests schedule history from the Nami cache", async () => {
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
  assert.equal(requestedUrl.searchParams.get("pid"), "103");
  assert.equal(requestedUrl.searchParams.get("live"), null);
  assert.equal(requestedUrl.searchParams.get("nm"), "1");
  assert.equal(requestedUrl.searchParams.get("stage_id"), "103697");
  assert.equal(result.recordTimeIso, "2026-09-03T09:53:32.000Z");
  await assert.rejects(() => fetchNamiSnapshot({ token: "x", provider: "dash", stageId: 999, fetchImpl: async () => null }), /不在.*目录/);
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
