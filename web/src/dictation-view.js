const LABELS = Object.freeze({
  idle: '听写已关闭',
  starting: '正在启动听写',
  listening: '听写中',
  transcribing: '正在转写',
  editing: '正在编辑草稿',
  'ready-to-send': '准备发送',
  paused: '听写已暂停',
  cancelled: '听写已取消',
  error: '听写不可用，请使用键盘输入',
})

export function dictationControlView({ enabled, state = 'idle' } = {}) {
  if (!enabled) return { visible: false, action: 'none', label: '' }
  if (state === 'paused') {
    return { visible: true, action: 'resume', label: LABELS[state] }
  }
  if (['starting', 'listening', 'transcribing', 'editing', 'ready-to-send'].includes(state)) {
    return { visible: true, action: 'pause', label: LABELS[state] }
  }
  return {
    visible: true,
    action: 'start',
    label: LABELS[state] || LABELS.error,
  }
}

export function requiresKeyboardFallback(event) {
  return event?.type === 'dictation.error'
}
