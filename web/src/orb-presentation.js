// 对话态：秒级瞬态，实时交互永远优先于后台态展示。
const CONVERSATION_STATES = new Set(['listening', 'thinking', 'speaking'])

// 悬浮球视觉状态仲裁器：所有事件源收敛为单一状态，优先级从高到低：
// 生命周期（hidden/waking）→ 连接异常（error）→ 对话态 →
// attention（后台等你确认）→ working（任务执行中）→
// occupied（他端占用）→ connecting → idle。
export function resolveOrbVisualState({
  lifecycle = 'active',
  connectionError = false,
  connecting = false,
  ownershipBusy = false,
  voiceState = 'idle',
  tasksActive = false,
  attentionPending = false,
} = {}) {
  if (lifecycle === 'hidden') return 'hidden'
  if (lifecycle === 'waking') return 'waking'
  if (connectionError) return 'error'
  if (CONVERSATION_STATES.has(voiceState)) return voiceState
  if (attentionPending) return 'attention'
  if (tasksActive) return 'working'
  if (ownershipBusy) return 'occupied'
  if (connecting) return 'connecting'
  return voiceState
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
