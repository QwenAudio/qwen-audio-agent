export function clean(value) {
  return String(value || '').trim()
}

export function reportActivity(callback, category, status, message) {
  callback?.({
    kind: 'status',
    category,
    status,
    message,
  })
}

export function toolResult(content, state, changed, data = {}) {
  return {
    content,
    stateVersion: state.version,
    changed,
    data,
  }
}
