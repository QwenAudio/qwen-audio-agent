const BACKEND_FAILURE_STATUSES = new Set(['failed'])
const BACKEND_FAILURE_CODES = new Set([
  'AUTH_REQUIRED',
  'CONFIG_REQUIRED',
  'NOT_INSTALLED',
  'PROCESS_EXITED',
  'PROTOCOL_MISMATCH',
  'START_FAILED',
  'START_TIMEOUT',
])

export function desktopBackendRuntime(backend = {}) {
  if (backend.enabled === false || backend.status === 'not_configured') {
    return 'skipped'
  }
  if (backend.ready === true || backend.status === 'ready') return 'ready'
  if (
    BACKEND_FAILURE_STATUSES.has(backend.status)
    || BACKEND_FAILURE_CODES.has(backend.code)
  ) return 'failed'
  return 'connecting'
}

export function desktopRealtimeRuntime(connectionState = 'connecting') {
  if (connectionState === 'connected') return 'ready'
  if (connectionState === 'unavailable') return 'failed'
  return 'connecting'
}

export function resolveDesktopRuntime({
  gateway = 'connecting',
  realtime = 'connecting',
  backend = 'connecting',
} = {}) {
  const components = { gateway, realtime, backend }
  if (Object.values(components).includes('failed')) {
    return { overall: 'failed', ...components }
  }
  if (
    gateway === 'ready'
    && realtime === 'ready'
    && ['ready', 'skipped'].includes(backend)
  ) {
    return { overall: 'ready', ...components }
  }
  return { overall: 'starting', ...components }
}

export function advanceDesktopRuntimePresentation({
  current = 'starting',
  readyAnnounced = false,
} = {}) {
  if (current === 'ready' && !readyAnnounced) {
    return { cue: 'ready', readyAnnounced: true }
  }
  return { cue: null, readyAnnounced }
}
