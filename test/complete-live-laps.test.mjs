import test from "node:test";
import assert from "node:assert/strict";
import { retainCompleteLiveLaps } from "../complete-live-laps.mjs";

const row = (times, lastLap = "1:30.000") => ({
  car: 1, lastLap,
  extra: { sectors: times.map((time, index) => ({ sector: index + 1, time, best_time: "25.000", time_color: "yellow" })) },
});

test("partial sectors cannot replace the most recent complete lap", () => {
  const cache = new Map();
  const initial = row(["30.000", "30.000", ""]);
  retainCompleteLiveLaps([initial], cache);
  assert.equal(initial.lastLap, null);
  assert.deepEqual(initial.extra.sectors.map((sector) => sector.time), ["", "", ""]);
  assert.equal(initial.extra.sectors[0].best_time, "25.000");
  retainCompleteLiveLaps([row(["30.000", "30.000", "30.000"])], cache);
  const partial = row(["31.000", "32.000", ""], "1:33.000");
  retainCompleteLiveLaps([partial], cache);
  assert.equal(partial.lastLap, "1:30.000");
  assert.deepEqual(partial.extra.sectors.map((sector) => sector.time), ["30.000", "30.000", "30.000"]);
  const complete = row(["31.000", "32.000", "30.000"], "1:33.000");
  retainCompleteLiveLaps([complete], cache);
  assert.equal(complete.lastLap, "1:33.000");
  assert.equal(cache.size, 1);
});

test("missing lap time or invalid sectors never create a complete lap", () => {
  for (const sample of [row(["30", "30", "30"], null), row(["30", "0", "30"]), row(["30", "bad", "30"])]) {
    const cache = new Map();
    retainCompleteLiveLaps([sample], cache);
    assert.equal(cache.size, 0);
    assert.equal(sample.lastLap, null);
  }
});

test("accumulates sectors across snapshots so a delayed S3 is not lost", () => {
  const cache = new Map();
  const partial = new Map();
  const first = row(["30.000", "31.000", ""], "1:31.000");
  first.lap = 12;
  retainCompleteLiveLaps([first], cache, partial);
  assert.equal(cache.size, 0);

  const second = row(["", "", "30.500"], null);
  second.lap = 12;
  retainCompleteLiveLaps([second], cache, partial);
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get("1").sectors.map((sector) => sector.time), ["30.000", "31.000", "30.500"]);
  assert.equal(second.lastLap, "1:31.000");
});

test("live display keeps a returned lap visible while S3 is still pending", () => {
  const cache = new Map();
  const partial = new Map();
  const live = row(["30.000", "31.000", ""], "1:31.000");
  live.lap = 12;
  retainCompleteLiveLaps([live], cache, partial, { displayPartial: true });
  assert.equal(live.lastLap, "1:31.000");
  assert.deepEqual(live.extra.sectors.map((sector) => sector.time), ["30.000", "31.000", ""]);
  assert.equal(cache.size, 0);
});
