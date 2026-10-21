import { pathToFileURL } from 'node:url'
import { NativeWebRtcMedia } from './media.mjs'

// Keep native wrappers strongly reachable until this disposable process exits.
// @roamhq/wrtc 0.10.0 on macOS arm64 crashes during natural V8 teardown, even
// for a stopped standalone audio track. This is a runtime lifecycle workaround,
// not a test-runner forced exit: close media, flush the acknowledgement, exit.
let media
let avatarSource = null
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
  try { avatarSource?.close() } catch { /* best effort */ }
  try { media?.close() } catch { code = 1 }
  if (!process.connected) { process.exit(code); return }
  try {
    process.send({ type: 'closed' }, error => process.exit(error ? 1 : code))
  } catch { process.exit(1) }
}

// The adapter module path only ever arrives via the init message, which is built
// from trusted server startup configuration — never from an HTTP/DataChannel
// request. Refuse anything that is not an absolute file: URL so a compromised
// control channel cannot make this worker import arbitrary code.
function assertAdapterModule(spec) {
  if (typeof spec !== 'string' || !spec) throw new Error('adapter module path required')
  const url = new URL(spec, pathToFileURL(process.cwd() + '/').href)
  if (url.protocol !== 'file:' || !spec.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(spec)) {
    throw new Error('adapter module path must be absolute')
  }
  return url.href
}

async function openAvatarSource({ adapterModulePath, adapterOptions = {}, binding }) {
  const href = assertAdapterModule(adapterModulePath)
  const module = await import(href)
  if (typeof module.createFramedAvSource !== 'function') throw new Error('adapter module must export createFramedAvSource')
  avatarSource = module.createFramedAvSource({
    binding,
    ...adapterOptions,
    onUnit: unit => { try { media?.dhAppendUnit(unit) } catch { send({ type: 'dh', op: 'error', code: 'invalid_media' }) } },
    onEvent: event => {
      if (event?.type === 'media_end') {
        // The renderer's media_end is the authoritative "all A/V echoed" signal.
        // Drive the playback end marker from it (deferred from dh.finish, which
        // fires on model-done far before the realtime echo completes).
        const turn = { responseId: event.turn?.responseId, generation: event.turn?.generation }
        try { media?.dhMediaEnd(turn) } catch { send({ type: 'dh', op: 'error', code: 'invalid_media' }) }
        send({ type: 'dh', op: 'media_end', responseId: turn.responseId, generation: turn.generation, reason: event.reason })
      }
    },
    onError: error => send({ type: 'dh', op: 'error', code: error?.code || 'protocol_error', message: String(error?.message || '') }),
    onClose: () => send({ type: 'dh', op: 'closed' }),
  })
  await avatarSource.ready
}

// Avatar failures degrade to audio-only; they must never tear down the audio
// peer connection, so this runs outside the fatal message handler.
async function handleAvatarMessage(message) {
  try {
    if (message.type === 'dh.open') { await openAvatarSource(message); send({ type: 'dh', op: 'opened' }); return }
    if (message.type === 'dh.begin') { media.dhBegin(message.turn, message.format, message.idle); return }
    if (message.type === 'dh.append') { media.dhAppendUnit(message.unit); return }
    if (message.type === 'dh.finish') { media.dhFinish(message.turn); return }
    if (message.type === 'dh.clear') { avatarSource?.clear?.(message.generation); media.dhClear(message.generation, message.block); return }
    if (message.type === 'dh.close') { try { avatarSource?.close() } catch { /* best effort */ } avatarSource = null; return }
  } catch (error) {
    send({ type: 'dh', op: 'error', code: error?.code || 'protocol_error', message: String(error?.message || '') })
  }
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
      media.onFail = message => send({ type: 'peer.failed', message: String(message).slice(0, 200) })
      media.onClose = () => send({ type: 'peer.closed' })
      media.onDhEvent = payload => send({ type: 'dh', ...payload })
      media.pc.addEventListener('connectionstatechange', () => send({ type: 'state', connected: media.connected() }))
      send({ type: 'ready' })
      return
    }
    if (message.type === 'close') { shutdown(); return }
    if (!media) throw new Error('media not initialized')
    if (message.type.startsWith('dh.')) { await handleAvatarMessage(message); return }
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
