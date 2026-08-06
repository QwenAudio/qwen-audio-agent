import { GatewayServerEvent } from '../../shared/realtime-events.mjs'

const ACTIVE_TASK_PHASES = new Set([
  'queued',
  'running',
  'delegated',
  'finalizing',
  'cancelling',
  'responding',
])

const ACTIVE_VOICE_STATES = new Set([
  'listening',
  'thinking',
  'speaking',
])

export function desktopAutoHideSeconds(search = '') {
  const params = new URLSearchParams(search)
  const configured = params.has('autoHideSeconds')
    ? params.get('autoHideSeconds')
    : params.get('autoSleepSeconds')
  if (configured === null) return 60
  const value = Number(configured)
  if (value === 0) return 0
  return Number.isInteger(value) && value >= 30 && value <= 3600
    ? value
    : 60
}

export function desktopWakeWordEnabled(search = '') {
  return new URLSearchParams(search).get('wakeWordEnabled') === 'true'
}

export function desktopWorkSettled({
  tasks = [],
  messages = [],
  voiceState = 'idle',
} = {}) {
  return (
    !tasks.some(task => (
      ACTIVE_TASK_PHASES.has(task.phase)
      || task.authorization?.status === 'pending'
    ))
    && !messages.some(message => message.live)
    && !ACTIVE_VOICE_STATES.has(voiceState)
  )
}

export function desktopCanHide({
  settled,
  connectionState,
  visualError = false,
  lifecycle = 'active',
} = {}) {
  return (
    lifecycle === 'active'
    && settled === true
    && connectionState === 'connected'
    && visualError !== true
  )
}

export function desktopHideDeadline({
  lastInteractionAt,
  workSettledAt,
  timeoutSeconds,
}) {
  if (!timeoutSeconds) return Infinity
  return Math.max(lastInteractionAt, workSettledAt) + timeoutSeconds * 1000
}

// Client state is a provider- and Gateway-level capability. This adapter owns
// only its desktop presentation: the generic "sleeping" state hides the orb.
export async function applyDesktopClientState(event, {
  desktop = false,
  bridge,
  onLifecycle = () => {},
} = {}) {
  if (
    !desktop
    || event?.type !== GatewayServerEvent.CLIENT_STATE
    || event.state !== 'sleeping'
    || typeof bridge?.enterHide !== 'function'
  ) return false

  const lifecycle = await bridge.enterHide()
  if (lifecycle?.state) onLifecycle(lifecycle.state)
  return lifecycle?.state === 'hidden'
}
