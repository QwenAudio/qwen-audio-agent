export const DEFAULT_SSE_KEEP_ALIVE_INTERVAL_MS = 15_000

/**
 * Keep a Server-Sent Events transport open without publishing a domain event.
 * SSE comments are ignored by EventSource clients and never enter Task replay
 * buffers or the durable Session Journal.
 */
export function startSseKeepAlive(response, {
  intervalMs = DEFAULT_SSE_KEEP_ALIVE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!response || typeof response.write !== 'function') {
    throw new TypeError('SSE response must provide write()')
  }
  const interval = Math.max(
    1,
    Number(intervalMs) || DEFAULT_SSE_KEEP_ALIVE_INTERVAL_MS,
  )
  let stopped = false
  let timer = null
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearIntervalFn(timer)
    response.off?.('close', stop)
    response.off?.('finish', stop)
  }
  const write = () => {
    if (response.destroyed || response.writableEnded) {
      stop()
      return
    }
    try {
      response.write(': keep-alive\n\n')
    } catch {
      stop()
    }
  }
  timer = setIntervalFn(write, interval)
  timer.unref?.()
  response.once?.('close', stop)
  response.once?.('finish', stop)
  return stop
}
