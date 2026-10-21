export function createTransientNotice(render, {
  durationMs = 6000,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let current = ''
  let timer = null
  return function notice(message = '') {
    const next = String(message || '')
    // Repeated connection/error callbacks must not keep extending one toast.
    if (next && next === current) return
    if (timer !== null) cancel(timer)
    current = next
    render(next)
    timer = next ? schedule(() => {
      timer = null
      current = ''
      render('')
    }, durationMs) : null
  }
}
