const seconds = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return seconds(value.value);
  const parts = String(value).trim().split(":");
  if (parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const result = parts.reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number.isFinite(result) && result > 0 ? result : null;
};

// Keep one complete lap per car; partial current-lap sectors are accumulated
// across polling snapshots until S1/S2/S3 and the lap time are all present.
export function retainCompleteLiveLaps(rows, cache, partialCache = new Map(), { displayPartial = false } = {}) {
  for (const row of rows) {
    const key = String(row.car);
    const incoming = row.extra?.sectors || [];
    const lap = row.lap == null ? null : Number(row.lap);
    const previousPartial = partialCache.get(key);
    const sameLap = previousPartial && lap != null && previousPartial.lap != null && Number(previousPartial.lap) === lap;
    const base = sameLap ? previousPartial.sectors : [];
    const merged = [1, 2, 3].map((sector) => {
      const current = incoming.find((item) => Number(item?.sector) === sector) || {};
      const previous = base.find((item) => Number(item?.sector) === sector) || {};
      const time = seconds(current.time) !== null ? current.time : previous.time ?? "";
      return { ...previous, ...current, sector, time };
    });
    const mergedLastLap = seconds(row.lastLap) !== null ? row.lastLap : previousPartial?.lastLap ?? null;
    const mergedLastLapColor = row.extra?.lastLapColor ?? previousPartial?.lastLapColor ?? null;
    partialCache.set(key, { lap, lastLap: mergedLastLap, lastLapColor: mergedLastLapColor, sectors: merged });
    if (seconds(mergedLastLap) !== null && merged.every((sector) => seconds(sector?.time) !== null)) {
      cache.set(key, { time: mergedLastLap, color: mergedLastLapColor, sectors: merged.map((sector) => ({ ...sector })) });
    }
    const previous = cache.get(key);
    const hasIncomingLap = seconds(mergedLastLap) !== null;
    const displayIncoming = displayPartial && hasIncomingLap && (!previous || previous.time !== mergedLastLap);
    const displaySectors = displayIncoming ? merged : previous?.sectors || (displayPartial ? merged : []);
    row.lastLap = displayIncoming ? mergedLastLap : previous?.time ?? null;
    row.extra = {
      ...row.extra,
      lastLapColor: displayIncoming ? mergedLastLapColor : previous?.color ?? null,
      sectors: [1, 2, 3].map((sector, index) => {
        const current = incoming.find((item) => Number(item?.sector) === sector) || {};
        return {
          ...current,
          sector,
          time: displaySectors[index]?.time ?? "",
          time_color: displaySectors[index]?.time_color ?? "",
        };
      }),
    };
  }
  return rows;
}
