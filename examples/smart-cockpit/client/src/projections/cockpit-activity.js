const SUPPORTED_DOMAINS = new Set([
  'navigation',
  'flashbuy',
  'music',
])

const TERMINAL_STAGES = new Set([
  'navigation_started',
  'route_ready',
  'navigation_stopped',
  'destination_not_found',
  'waypoint_not_found',
  'route_failed',
  'flashbuy_results_ready',
  'flashbuy_preview_ready',
  'flashbuy_cart_updated',
  'flashbuy_order_completed',
  'flashbuy_cancelled',
  'music_started',
  'music_paused',
  'music_track_changed',
  'music_results_ready',
])

export function cockpitProgressFromActivity(activity) {
  const domain = String(activity?.category || '').trim()
  const stage = String(activity?.status || '').trim()
  const message = String(activity?.message || '').trim()
  if (!SUPPORTED_DOMAINS.has(domain) || !stage || !message) return null
  return {
    domain,
    stage,
    message,
    source: 'cockpit-service',
  }
}

export function isTerminalCockpitProgress(progress) {
  return TERMINAL_STAGES.has(progress?.stage)
}

export function cockpitScreenForProgress(progress, {
  navigationActive = false,
} = {}) {
  if (progress?.domain === 'navigation') return 'main'
  if (progress?.domain === 'flashbuy') return 'flashbuy'
  if (
    progress?.domain === 'music'
    && progress.stage === 'music_started'
    && !navigationActive
  ) return 'music'
  return null
}
