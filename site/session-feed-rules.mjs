const hasTimingValue = (value) => value !== null && value !== undefined && value !== "";

export function isCompleteLapRecord(lap) {
  return hasTimingValue(lap?.lap_duration) && hasTimingValue(lap?.duration_sector_3);
}

export function collectSessionFeedRows(field, rows) {
  if (!Array.isArray(rows) || field !== "laps") return rows;
  return rows.filter(isCompleteLapRecord);
}
