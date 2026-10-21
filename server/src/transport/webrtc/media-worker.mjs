import { NativeWebRtcMedia } from './media.mjs'

// Keep native wrappers strongly reachable until this disposable process exits.
// @roamhq/wrtc 0.10.0 on macOS arm64 crashes during natural V8 teardown, even
// for a stopped standalone audio track. This is a runtime lifecycle workaround,
// not a test-runner forced exit: close media, flush the acknowledgement, exit.
let media
let shuttingDown = false
let pendingBytes = 0

function send(message) {
  if (shuttingDown || !process.connected) return
  const bytes = Buffer.byteLength(JSON.stringify(message))
  if (pendingBytes + bytes > 8 * 1024 * 1024) { shutdown(1); return }
  pendingBytes += bytes
  try {
    process.send(message, error => {
      pendingBytes -= bytes
      if (error) shutdown(1)
    })
  } catch { pendingBytes -= bytes; shutdown(1) }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try { media?.close() } catch { code = 1 }
  if (!process.connected) { process.exit(code); return }
  try {
    process.send({ type: 'closed' }, error => process.exit(error ? 1 : code))
  } catch { process.exit(1) }
}

function publicError(error) {
  return error?.status && error?.code
    ? { status: error.status, code: error.code, message: error.message }
    : { status: 400, code: 'webrtc_negotiation_failed', message: 'WebRTC negotiation failed' }
}

process.on('disconnect', () => shutdown())
process.on('message', async message => {
  if (shuttingDown) return
  try {
    if (message.type === 'init' && !media) {
      media = new NativeWebRtcMedia(message.options)
      media.onOpen = () => send({ type: 'open' })
      media.onEvent = data => {
        if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) { shutdown(1); return }
        send({ type: 'event', data })
      }
      media.onAudio = data => send({ type: 'audio', data })
      media.onImage = data => send({ type: 'image', data })
      media.onClose = () => send({ type: 'peer.closed' })
      media.pc.addEventListener('connectionstatechange', () => send({ type: 'state', connected: media.connected() }))
      send({ type: 'ready' })
      return
    }
    if (message.type === 'close') { shutdown(); return }
    if (!media) throw new Error('media not initialized')
    if (message.type === 'answer') send({ type: 'answer', id: message.id, sdp: await media.answer(message.sdp) })
    else if (message.type === 'send') media.send(message.event)
    else if (message.type === 'begin') media.begin(message.responseId)
    else if (message.type === 'append') media.append(message.event)
    else if (message.type === 'finish') media.finish(message.responseId)
    else if (message.type === 'clear') media.clear()
    else if (message.type === 'rate') media.inputSampleRate = message.value
  } catch (error) {
    send({ type: message.type === 'answer' ? 'answer.error' : 'failure', id: message.id, error: publicError(error) })
    if (message.type !== 'answer') shutdown(1)
  }
})
