export const WEBSOCKET_AUDIO_BUFFER_LIMIT = 512 * 1024
export const WEBSOCKET_CONTROL_BUFFER_LIMIT = 1024 * 1024
export const WEBSOCKET_MESSAGE_LIMIT = 20 * 1024 * 1024

const failedSockets = new WeakSet()

// Do not add an application queue in front of ws's own queue. Once a peer is
// too slow, terminate its stream so normal disconnect/recovery runs. Dropping
// individual audio chunks would leave a connected but corrupted conversation.
export function sendBoundedWebSocket(ws, data, { audio = false, onFailure } = {}) {
  if (ws?.readyState !== 1 || failedSockets.has(ws)) return false
  const size = Buffer.byteLength(data)
  const bufferedBytes = Number(ws.bufferedAmount) || 0
  const limit = audio ? WEBSOCKET_AUDIO_BUFFER_LIMIT : WEBSOCKET_CONTROL_BUFFER_LIMIT
  const fail = (code, error) => {
    if (failedSockets.has(ws)) return
    failedSockets.add(ws)
    try {
      onFailure?.({ code, bufferedBytes, messageBytes: size, limit, error })
    } catch {
      // Diagnostics must not prevent transport cleanup or escape callbacks.
    } finally {
      ws.terminate()
    }
  }
  // A large control message (e.g. an attachment) may be sent to an empty queue.
  // Subsequent messages cannot grow that queue further. Audio never gets this
  // exception: its budget bounds both memory and stale-speech latency.
  const budget = audio ? limit : Math.max(limit, size)
  if (size > WEBSOCKET_MESSAGE_LIMIT || bufferedBytes + size > budget) {
    fail('websocket_backpressure')
    return false
  }
  try {
    ws.send(data, error => { if (error) fail('websocket_send_failed', error) })
    return !failedSockets.has(ws)
  } catch (error) {
    fail('websocket_send_failed', error)
    return false
  }
}
