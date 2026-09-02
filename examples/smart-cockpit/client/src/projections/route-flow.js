export const ROUTE_FLOW_DURATION_MS = 2200

export function routeFlowFrame(points, elapsedMs, {
  durationMs = ROUTE_FLOW_DURATION_MS,
} = {}) {
  if (!Array.isArray(points) || !points.length) {
    return { path: [], done: true }
  }
  const duration = Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : ROUTE_FLOW_DURATION_MS
  const progress = Math.min(1, Math.max(0, Number(elapsedMs) || 0) / duration)
  const segmentSize = Math.min(points.length, Math.max(6, Math.floor(points.length * 0.08)))
  const lastStart = Math.max(0, points.length - segmentSize)
  const startIndex = Math.min(lastStart, Math.floor(progress * lastStart))
  return {
    path: points.slice(startIndex, startIndex + segmentSize),
    done: progress >= 1,
  }
}
