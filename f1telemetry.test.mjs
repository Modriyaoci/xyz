import test from "node:test";
import assert from "node:assert/strict";

import { adaptF1TelemetryState } from "./f1telemetry.mjs";
import { mapOpenF1ToBackend } from "./backend-fields.mjs";

test("converts tyre ages into per-stint and cumulative race laps", () => {
  const data = adaptF1TelemetryState({
    R: {
      SessionInfo: { Key: 1, Meeting: { Key: 2 } },
      DriverList: { 1: { RacingNumber: "1" } },
      TimingData: { Lines: { 1: { RacingNumber: "1" } } },
      TyreStintSeries: {
        Stints: {
          1: [
            { Compound: "MEDIUM", New: "true", TotalLaps: 2, StartLaps: 0 },
            { Compound: "SOFT", New: "false", TotalLaps: 22, StartLaps: 3 },
            { Compound: "HARD", New: "true", TotalLaps: 26, StartLaps: 0 },
            { Compound: "HARD", New: "true", TyresNotChanged: "1", TotalLaps: 25, StartLaps: 0 },
          ],
        },
      },
    },
  });

  assert.deepEqual(
    data.stints.map(({ compound, lap_start, lap_end, total_laps, start_laps, end_laps, tyres_not_changed }) => ({
      compound,
      lap_start,
      lap_end,
      total_laps,
      start_laps,
      end_laps,
      tyres_not_changed,
    })),
    [
      { compound: "MEDIUM", lap_start: 1, lap_end: 2, total_laps: 2, start_laps: 0, end_laps: 2, tyres_not_changed: false },
      { compound: "SOFT", lap_start: 3, lap_end: 21, total_laps: 19, start_laps: 3, end_laps: 22, tyres_not_changed: false },
      { compound: "HARD", lap_start: 22, lap_end: 47, total_laps: 26, start_laps: 0, end_laps: 26, tyres_not_changed: false },
      { compound: "HARD", lap_start: 48, lap_end: 72, total_laps: 25, start_laps: 0, end_laps: 25, tyres_not_changed: true },
    ],
  );
});

test("falls back to TimingAppData stints and ignores metadata", () => {
  const data = adaptF1TelemetryState({
    R: {
      SessionInfo: { Key: 1, Meeting: { Key: 2 } },
      TimingAppData: {
        Lines: {
          _kf: true,
          4: {
            Stints: {
              0: { Compound: "soft", TotalLaps: 9, StartLaps: 2 },
              _kf: true,
            },
          },
        },
      },
    },
  });

  assert.equal(data.stints.length, 1);
  assert.deepEqual(
    data.stints[0],
    {
      driver_number: 4,
      stint_number: 1,
      compound: "SOFT",
      lap_start: 1,
      lap_end: 7,
      lap_number: null,
      lap_time: "",
      total_laps: 7,
      start_laps: 2,
      end_laps: 9,
      is_new: false,
      tyres_not_changed: false,
      lap_flags: 0,
    },
  );
});

test("preserves authoritative Telemetry timing colours", () => {
  const data = adaptF1TelemetryState({
    R: {
      SessionInfo: { Key: 1, Meeting: { Key: 2 } },
      DriverList: {
        1: { RacingNumber: "1", Tla: "NOR" },
        16: { RacingNumber: "16", Tla: "LEC" },
      },
      TimingData: {
        Lines: {
          1: {
            RacingNumber: "1",
            LastLapTime: { Value: "1:31.000", OverallFastest: false, PersonalFastest: true },
            BestLapTime: { Value: "1:30.000" },
            Sectors: [
              { Value: "31.000", PreviousValue: "31.000", OverallFastest: false, PersonalFastest: false },
              { Value: "32.000", PreviousValue: "32.000", OverallFastest: false, PersonalFastest: true },
              { Value: "", PreviousValue: "28.000", OverallFastest: false, PersonalFastest: false },
            ],
          },
          16: {
            RacingNumber: "16",
            LastLapTime: { Value: "1:29.000", OverallFastest: true, PersonalFastest: true },
            BestLapTime: { Value: "1:29.000" },
            Sectors: [
              { Value: "28.000", PreviousValue: "29.000", OverallFastest: true, PersonalFastest: true },
              { Value: "33.000", PreviousValue: "33.000", OverallFastest: false, PersonalFastest: false },
              { Value: "29.000", PreviousValue: "29.000", OverallFastest: false, PersonalFastest: false },
            ],
          },
        },
      },
      TimingStats: {
        Lines: {
          1: {
            BestSectors: [
              { Value: "29.000", Position: 2 },
              { Value: "32.000", Position: 1 },
              { Value: "28.000", Position: 1 },
            ],
          },
          16: {
            BestSectors: [
              { Value: "28.000", Position: 1 },
              { Value: "33.000", Position: 2 },
              { Value: "29.000", Position: 2 },
            ],
          },
        },
      },
    },
  });

  const norris = data.session_result.find((row) => row.driver_number === 1);
  assert.equal(norris.sector_1_overall_fastest, false);
  assert.equal(norris.sector_2_personal_fastest, true);
  assert.equal(norris.duration_sector_3_source, "previous");

  const mapped = mapOpenF1ToBackend(data);
  assert.equal(mapped.extra.last_lap_time_color["347506"], "green");
  assert.equal(mapped.extra.last_lap_time_color["347492"], "purple");
  assert.deepEqual(
    mapped.extra.sectors["347506"].map((sector) => [sector.time_color, sector.best_time_color]),
    [["yellow", "green"], ["green", "purple"], ["purple", "purple"]],
  );
  assert.deepEqual(
    mapped.extra.sectors["347492"].map((sector) => [sector.time_color, sector.best_time_color]),
    [["purple", "purple"], ["yellow", "green"], ["yellow", "green"]],
  );
});
