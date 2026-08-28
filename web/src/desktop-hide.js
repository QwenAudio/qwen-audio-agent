import { GatewayServerEvent } from '../../shared/realtime-events.mjs'
import {
  GatewayClientActionName,
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'

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
  'processing',
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

export function desktopTasksActive(tasks = []) {
  return tasks.some(task => (
    ACTIVE_TASK_PHASES.has(task.phase)
    || task.authorization?.status === 'pending'
  ))
}

// 动画只呈现实际执行中的后台工作。等待授权仍属于 active，用于阻止
// 自动休眠，但它是一次前后台交互，不是 working 动画状态。
export function desktopTasksWorking(tasks = []) {
  return tasks.some(task => (
    ACTIVE_TASK_PHASES.has(task.phase)
    && task.authorization?.status !== 'pending'
  ))
}

export function desktopWorkSettled({
  tasks = [],
  voiceState = 'idle',
} = {}) {
  return (
    !desktopTasksActive(tasks)
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

export function desktopCanFinishWaking(connectionState) {
  return connectionState === 'connected' || connectionState === 'unavailable'
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
// 刚被用户显式唤醒的宽限期内忽略 sleeping 广播：Gateway 的休眠计时器
// 可能恰好在唤醒瞬间到期，迟到的过期指令不应把悬浮球藏回去
// （随后的 voice.wake 会重新唤醒 Gateway）。
export const DESKTOP_WAKE_GRACE_MS = 5000

export async function performDesktopClientAction(event, {
  desktop = false,
  bridge,
  onLifecycle = () => {},
} = {}) {
  if (event?.type !== GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST) return null
  if (
    !desktop
    || event.name !== GatewayClientActionName.ENTER_SLEEP
    || typeof bridge?.enterHide !== 'function'
  ) {
    return {
      status: 'unsupported',
      error: {
        code: 'client_action_unsupported',
        message: `Unsupported Client Action: ${String(event?.name || '')}`,
      },
    }
  }
  try {
    // A Client Action is an explicit model/user request. It must not be
    // blocked by the grace period used only for stale automatic sleep events.
    const lifecycle = await bridge.enterHide({ explicit: true })
    if (lifecycle?.state) onLifecycle(lifecycle.state)
    if (lifecycle?.state !== 'hidden') {
      return {
        status: 'failed',
        error: {
          code: 'desktop_hide_incomplete',
          message: 'Desktop did not enter the hidden state',
        },
      }
    }
    return { status: 'completed', output: { state: 'hidden' } }
  } catch (error) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_hide_failed',
        message: String(error?.message || error).slice(0, 500),
      },
    }
  }
}

export async function applyDesktopClientState(event, {
  desktop = false,
  bridge,
  onLifecycle = () => {},
  lastWakeAt = 0,
  now = Date.now(),
} = {}) {
  if (
    !desktop
    || event?.type !== GatewayServerEvent.CLIENT_STATE
    || event.state !== 'sleeping'
    || typeof bridge?.enterHide !== 'function'
    || now - lastWakeAt < DESKTOP_WAKE_GRACE_MS
  ) return false

  const lifecycle = await bridge.enterHide()
  if (lifecycle?.state) onLifecycle(lifecycle.state)
  return lifecycle?.state === 'hidden'
}
