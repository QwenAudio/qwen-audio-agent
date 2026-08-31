const TERMINAL_STAGES = new Set([
  'navigation_started',
  'route_ready',
  'navigation_stopped',
  'destination_not_found',
  'via_not_found',
  'route_failed',
])

export function navigationProgressFromActivity(activity) {
  if (activity?.category !== 'navigation') return null
  const stage = String(activity.status || '').trim()
  const message = String(activity.message || '').trim()
  if (!stage || !message) return null
  return {
    domain: 'navigation',
    stage,
    message,
    source: 'cockpit-domain',
  }
}

export function isTerminalNavigationProgress(progress) {
  return TERMINAL_STAGES.has(progress?.stage)
}
