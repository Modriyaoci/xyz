const hasTimingValue = (value) => value !== null && value !== undefined && value !== "";

export function isCompleteLapRecord(lap) {
  return hasTimingValue(lap?.lap_duration) && hasTimingValue(lap?.duration_sector_3);
}

export function collectSessionFeedRows(field, rows) {
  if (!Array.isArray(rows) || field !== "laps") return rows;
  return rows.filter(isCompleteLapRecord);
}

export function completeSessionResultRows(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const drivers = Array.isArray(data.drivers) ? data.drivers : [];
  const results = Array.isArray(data.session_result) ? data.session_result.slice() : [];
  const resultCars = new Set(results.map((row) => Number(row?.driver_number)).filter(Number.isFinite));
  for (const driver of drivers) {
    const car = Number(driver?.driver_number);
    if (!Number.isFinite(car) || resultCars.has(car)) continue;
    results.push({
      driver_number: car,
      meeting_key: driver.meeting_key ?? data.meeting?.meeting_key ?? data.session?.meeting_key ?? null,
      session_key: driver.session_key ?? data.session?.session_key ?? null,
      position: null,
      duration: null,
      gap_to_leader: null,
      number_of_laps: null,
      points: null,
      dnf: false,
      dns: false,
      dsq: false,
      is_result_missing: true,
    });
    resultCars.add(car);
  }
  data.session_result = results.sort((a, b) => {
    const left = Number(a?.position);
    const right = Number(b?.position);
    const leftPosition = Number.isFinite(left) && left > 0 ? left : Infinity;
    const rightPosition = Number.isFinite(right) && right > 0 ? right : Infinity;
    return leftPosition - rightPosition || Number(a?.driver_number) - Number(b?.driver_number);
  });
  return data;
}
