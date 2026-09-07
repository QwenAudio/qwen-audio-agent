// 对话态：秒级瞬态，实时交互永远优先于后台态展示。
const CONVERSATION_STATES = new Set(['listening', 'processing', 'speaking'])

// 悬浮球视觉状态仲裁器：所有事件源收敛为单一状态，优先级从高到低：
// 生命周期（hidden/waking）→ 连接异常（error）→ 对话态 →
// working（后台任务执行中）→ occupied（他端占用）→ connecting → idle。
// 授权请求是独立的前后台交互，不占用 Agent 动画状态。
export function resolveOrbVisualState({
  lifecycle = 'active',
  runtimeState = null,
  connectionError = false,
  connecting = false,
  ownershipBusy = false,
  voiceState = 'idle',
  tasksWorking = false,
} = {}) {
  if (lifecycle === 'hidden') return 'hidden'
  if (lifecycle === 'waking') return 'waking'
  if (runtimeState === 'failed') return 'error'
  if (runtimeState === 'starting') return 'starting'
  if (connectionError) return 'error'
  if (CONVERSATION_STATES.has(voiceState)) return voiceState
  if (tasksWorking) return 'working'
  if (ownershipBusy) return 'occupied'
  if (connecting) return 'connecting'
  // Voice providers may add private states, but presentation is a closed
  // protocol. Unknown values must not leak into CSS classes or pet tracks.
  return 'idle'
}

export function desktopOrbClassName({
  state,
  enabled,
  error = false,
  dragging = false,
  lifecycle = 'active',
}) {
  return [
    'desktop-orb-stage',
    state,
    enabled ? 'enabled' : 'input-muted',
    error ? 'error' : '',
    dragging ? 'dragging' : '',
    lifecycle !== 'active' ? lifecycle : '',
  ].filter(Boolean).join(' ')
}
