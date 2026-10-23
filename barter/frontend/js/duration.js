// Engine durations are minutes; round only after summing.
export function totalDepartureDuration(sorties) {
  if (sorties.some(row => typeof row.totalTime !== "number" || !Number.isFinite(row.totalTime) || row.totalTime < 0)) return "미확인";
  const seconds = Math.round(sorties.reduce((sum, row) => sum + row.totalTime * 60, 0));
  if (!Number.isSafeInteger(seconds)) return "미확인";
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분 ${seconds % 60}초`;
}
