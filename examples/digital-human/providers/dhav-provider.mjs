// DigitalHumanProvider SPI over the DHAV private renderer protocol.
// Vendor-neutral: the same adapter drives the local Mock renderer and the
// M2 Python OpenAvatarChat renderer. Control plane only — paired media bytes
// flow renderer -> media worker directly and never touch this module.

import { createRequire } from 'node:module'
import {
  ControlOp, DhavError, INPUT_AUDIO_FORMAT,
  encodeControl, encodeInputPcm, decodeMediaEvent,
} from '../protocol/dhav.mjs'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

export const PROVIDER_ERROR_CODES = Object.freeze(['unavailable', 'capacity_exhausted', 'invalid_media', 'first_media_timeout', 'media_stalled', 'protocol_error'])

export class DhavProviderError extends Error {
  constructor(code, message, { rebuild = false } = {}) {
    super(message)
    this.name = 'DhavProviderError'
    if (!PROVIDER_ERROR_CODES.includes(code)) throw new Error(`unknown provider error code ${code}`)
    this.code = code
    this.rebuild = rebuild
  }
}

const CAPABILITIES = Object.freeze({
  version: 1,
  streamingAudio: true,
  inputAudioFormats: [INPUT_AUDIO_FORMAT],
  textInput: 'none',
  interrupt: true,
  idle: true,
  outputModes: ['paired_av'],
})

function createEventQueue() {
  const queue = []
  let waiting = null
  let done = false
  return {
    get closed() { return done },
    push(event) {
      if (done) return
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value: event, done: false }) } else queue.push(event)
    },
    close() {
      if (done) return
      done = true
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value: undefined, done: true }) }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue }
        if (done) return
        const result = await new Promise(resolve => { waiting = resolve })
        if (result.done) return
        yield result.value
      }
    },
  }
}

export function createDhavProvider({
  rendererBaseUrl, authToken = null, fetch: request = globalThis.fetch, WebSocket: Socket = WebSocket,
  connectTimeoutMs = 5000, requestTimeoutMs = 5000, firstMediaTimeoutMs = 3000,
  mediaStallTimeoutMs = 3000, heartbeatTimeoutMs = 6000, maxBufferedInputBytes = 512 * 1024,
} = {}) {
  if (typeof rendererBaseUrl !== 'string' || !/^https?:\/\/|^ws/.test(rendererBaseUrl)) throw new DhavProviderError('unavailable', 'rendererBaseUrl required')
  const httpBase = rendererBaseUrl.replace(/^ws/, 'http').replace(/\/$/, '')

  return {
    async capabilities() { return CAPABILITIES },
    async openSession({ persona, format = INPUT_AUDIO_FORMAT, signal }) {
      if (!persona || typeof persona.personaId !== 'string') throw new DhavProviderError('unavailable', 'trusted persona required')
      const response = await request(`${httpBase}/v1/avatar/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ personaId: persona.personaId, protocolVersion: 1, inputFormat: format, avatarAssetId: persona.avatarAssetId ?? null }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)].filter(Boolean)),
      })
      if (response.status === 409) throw new DhavProviderError('capacity_exhausted', 'renderer has no free avatar session', { rebuild: true })
      if (!response.ok) throw new DhavProviderError('unavailable', `renderer session creation failed: HTTP ${response.status}`, { rebuild: true })
      const created = await response.json()
      if (!created?.avatarSessionId || !created?.input?.url || !created?.media?.url) throw new DhavProviderError('protocol_error', 'malformed session creation response')
      return createSession({ created, persona, format, Socket, signal, connectTimeoutMs, firstMediaTimeoutMs, mediaStallTimeoutMs, heartbeatTimeoutMs, maxBufferedInputBytes, request, requestTimeoutMs, httpBase, authToken })
    },
  }
}

function createSession({ created, persona, format, Socket, signal, connectTimeoutMs,
  firstMediaTimeoutMs, mediaStallTimeoutMs, heartbeatTimeoutMs, maxBufferedInputBytes,
  request, requestTimeoutMs, httpBase, authToken }) {
  const avatarSessionId = created.avatarSessionId
  const events = createEventQueue()
  const socket = new Socket(created.input.url, { headers: { authorization: `Bearer ${created.input.token}` } })
  let state = 'opening'
  let closed = false
  let closePromise = null
  let currentTurn = null
  let requestId = 0
  let firstMediaTimer = null
  let stallTimer = null
  let heartbeatTimer = null
  let connectTimer = setTimeout(() => failLocal(new DhavProviderError('unavailable', 'renderer input channel connect timed out', { rebuild: true })), connectTimeoutMs)

  // Internal descriptor handed to the media worker (via the orchestrator).
  // Media-channel credential only; it cannot create sessions or send input.
  const mediaBinding = Object.freeze({
    adapterId: created.mediaAdapterId || 'dhav-framed-av',
    protocol: 'dhav',
    protocolVersion: 1,
    avatarSessionId,
    media: Object.freeze({ url: created.media.url, token: created.media.token }),
    video: Object.freeze({ format: 'i420', width: created.video?.width || 256, height: created.video?.height || 256, fps: created.video?.fps || 25 }),
    inputFormat: Object.freeze({ ...format }),
  })

  socket.addEventListener('open', () => {
    clearTimeout(connectTimer)
    state = 'open'
    armHeartbeat()
  })
  socket.addEventListener('message', ({ data }) => {
    armHeartbeat()
    if (typeof data !== 'string') { failLocal(new DhavProviderError('protocol_error', 'input channel expects text frames only')); return }
    let frame
    try { frame = decodeMediaEvent(data) } catch (error) { failLocal(new DhavProviderError('protocol_error', error.message)); return }
    received(frame)
  })
  socket.addEventListener('error', () => {
    if (!closed) failLocal(new DhavProviderError('unavailable', 'renderer input channel error', { rebuild: true }))
  })
  socket.addEventListener('close', () => {
    if (!closed) failLocal(new DhavProviderError('unavailable', 'renderer input channel closed', { rebuild: true }))
  })
  if (signal) {
    if (signal.aborted) void closeSession()
    else signal.addEventListener('abort', () => void closeSession(), { once: true })
  }

  function closeSession() {
    if (closePromise) return closePromise
    closed = true
    clearTurnTimers()
    clearTimeout(connectTimer)
    clearTimeout(heartbeatTimer)
    closePromise = (async () => {
      try { if (socket.readyState === Socket.OPEN) sendControl({ op: ControlOp.CLOSE }) } catch { /* best effort */ }
      socket.close()
      await request(`${httpBase}/v1/avatar/sessions/${encodeURIComponent(avatarSessionId)}`, {
        method: 'DELETE',
        headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        signal: AbortSignal.timeout(requestTimeoutMs),
      }).catch(() => {})
      events.close()
    })()
    return closePromise
  }

  function armHeartbeat() {
    clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => failLocal(new DhavProviderError('unavailable', 'renderer heartbeat lost', { rebuild: true })), heartbeatTimeoutMs)
    heartbeatTimer.unref?.()
  }

  function received(frame) {
    if (frame.event === 'heartbeat') return
    if (frame.event === 'session.ready') {
      if (state === 'open') state = 'ready'
      events.push({ type: 'session.ready', avatarSessionId })
      return
    }
    if (frame.event === 'turn.progress') {
      if (currentTurn && sameTurn(currentTurn.ref, frame.turn)) armStall()
      return
    }
    if (frame.event === 'turn.first_media') {
      if (!frame.turn) { failLocal(new DhavProviderError('protocol_error', 'turn.first_media without TurnRef')); return }
      if (currentTurn && sameTurn(currentTurn.ref, frame.turn)) {
        clearTimeout(firstMediaTimer)
        currentTurn.firstMediaSeen = true
        armStall()
      }
      events.push({ type: 'turn.first_media', turn: frame.turn })
      return
    }
    if (frame.event === 'turn.completed') {
      if (!frame.turn) { failLocal(new DhavProviderError('protocol_error', 'turn.completed without TurnRef')); return }
      if (currentTurn && sameTurn(currentTurn.ref, frame.turn)) { clearTurnTimers(); currentTurn = null }
      events.push({ type: 'turn.completed', turn: frame.turn, lastSequence: frame.lastSequence ?? null })
      return
    }
    if (frame.event === 'turn.cancelled') {
      if (!frame.turn) { failLocal(new DhavProviderError('protocol_error', 'turn.cancelled without TurnRef')); return }
      if (currentTurn && sameTurn(currentTurn.ref, frame.turn)) { clearTurnTimers(); currentTurn = null }
      events.push({ type: 'turn.cancelled', turn: frame.turn, reason: frame.reason || 'provider_failure' })
      return
    }
    if (frame.event === 'provider.error') {
      const code = PROVIDER_ERROR_CODES.includes(frame.code) ? frame.code : 'protocol_error'
      if (currentTurn && (!frame.turn || sameTurn(currentTurn.ref, frame.turn))) { clearTurnTimers(); currentTurn = null }
      events.push({ type: 'provider.error', turn: frame.turn || null, code, message: typeof frame.message === 'string' ? frame.message.slice(0, 200) : '', rebuild: frame.rebuild !== false })
      return
    }
    failLocal(new DhavProviderError('protocol_error', `unknown renderer event ${frame.event}`))
  }

  function failLocal(error) {
    if (closed) return
    clearTurnTimers()
    clearTimeout(connectTimer)
    clearTimeout(heartbeatTimer)
    events.push({ type: 'provider.error', turn: currentTurn?.ref || null, code: error.code, message: error.message, rebuild: error.rebuild })
    currentTurn = null
    void closeSession()
  }

  function armStall() {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      if (!currentTurn) return
      const turn = currentTurn.ref
      sendCancel(turn, 'provider_failure')
      clearTurnTimers()
      currentTurn = null
      events.push({ type: 'provider.error', turn, code: 'media_stalled', message: 'renderer media progress stalled', rebuild: true })
    }, mediaStallTimeoutMs)
    stallTimer.unref?.()
  }

  function clearTurnTimers() {
    clearTimeout(firstMediaTimer)
    clearTimeout(stallTimer)
    firstMediaTimer = null
    stallTimer = null
  }

  function sameTurn(a, b) {
    return Boolean(a && b && a.avatarSessionId === b.avatarSessionId && a.responseId === b.responseId && a.generation === b.generation)
  }

  function sendControl(frame) {
    if (closed || socket.readyState !== Socket.OPEN) throw new DhavProviderError('unavailable', 'renderer input channel not open', { rebuild: true })
    socket.send(encodeControl({ requestId: `req-${++requestId}`, ...frame }))
  }

  function sendCancel(turn, reason) {
    try { sendControl({ op: ControlOp.CANCEL, turn, reason }) } catch { /* best effort during failure paths */ }
  }

  const session = {
    avatarSessionId,
    personaId: persona.personaId,
    mediaBinding,
    get state() { return closed ? 'closed' : state },

    async startTurn(ref) {
      if (closed) throw new DhavProviderError('unavailable', 'session closed', { rebuild: true })
      if (state !== 'ready') throw new DhavProviderError('unavailable', 'session not ready', { rebuild: true })
      if (currentTurn) {
        // Implicit supersede (user barge-in): a new turn displaces the active one.
        // The control channel is a single ordered WebSocket, so writing CANCEL
        // immediately before START guarantees the renderer stops the old turn
        // before it begins the new one — no round-trip wait. The old turn is
        // released locally now; its late turn.cancelled/turn.completed events
        // are ignored because the sameTurn guards below no longer match.
        sendCancel(currentTurn.ref, 'user_interruption')
        clearTurnTimers()
        currentTurn = null
      }
      currentTurn = { ref: { ...ref }, expectedSequence: 0, totalSamples: 0, firstMediaSeen: false, finished: false, cancelRequested: false }
      sendControl({ op: ControlOp.START, turn: currentTurn.ref, inputFormat: format })
      firstMediaTimer = setTimeout(() => {
        if (!currentTurn || currentTurn.firstMediaSeen) return
        const turn = currentTurn.ref
        sendCancel(turn, 'provider_failure')
        clearTurnTimers()
        currentTurn = null
        events.push({ type: 'provider.error', turn, code: 'first_media_timeout', message: 'renderer produced no first media in time', rebuild: true })
      }, firstMediaTimeoutMs)
      firstMediaTimer.unref?.()
    },

    async appendAudio({ avatarSessionId: sid, responseId, generation, sequence, sampleOffset, data }) {
      if (!currentTurn) throw new DhavProviderError('protocol_error', 'no active turn')
      const ref = currentTurn.ref
      if (ref.avatarSessionId !== sid || ref.responseId !== responseId || ref.generation !== generation) throw new DhavProviderError('protocol_error', 'TurnRef mismatch')
      if (currentTurn.finished || currentTurn.cancelRequested) throw new DhavProviderError('protocol_error', 'turn already sealed')
      if (sequence !== currentTurn.expectedSequence) throw new DhavProviderError('protocol_error', `sequence gap: expected ${currentTurn.expectedSequence}, got ${sequence}`)
      if (socket.bufferedAmount > maxBufferedInputBytes) throw new DhavProviderError('capacity_exhausted', 'renderer input backpressure', { rebuild: true })
      const samples = data.byteLength / 2
      let record
      try {
        record = encodeInputPcm({ turn: ref, sequence, sampleOffset, samples, format, payload: data })
      } catch (error) {
        if (error instanceof DhavError) throw new DhavProviderError('protocol_error', error.message)
        throw error
      }
      const turn = currentTurn
      await new Promise((resolve, reject) => socket.send(record, error => error ? reject(new DhavProviderError('unavailable', 'input send failed', { rebuild: true })) : resolve()))
      // The turn can be released while the send is in flight (supersede, stall
      // timer, renderer error). Bookkeeping belongs to the turn that was sent,
      // so skip it rather than writing through a nulled currentTurn.
      if (currentTurn !== turn) return
      currentTurn.expectedSequence = sequence + 1
      currentTurn.totalSamples = sampleOffset + samples
    },

    async finishTurn({ avatarSessionId: sid, responseId, generation, lastAudioSequence, totalSamples }) {
      if (!currentTurn || !sameTurn(currentTurn.ref, { avatarSessionId: sid, responseId, generation })) return
      if (currentTurn.finished) return
      if (lastAudioSequence !== currentTurn.expectedSequence - 1 || totalSamples !== currentTurn.totalSamples) {
        throw new DhavProviderError('protocol_error', `finish mismatch: lastAudioSequence=${lastAudioSequence} totalSamples=${totalSamples}, provider saw ${currentTurn.expectedSequence - 1}/${currentTurn.totalSamples}`)
      }
      currentTurn.finished = true
      sendControl({ op: ControlOp.FINISH, turn: currentTurn.ref, lastAudioSequence, totalSamples })
    },

    async interruptTurn({ avatarSessionId: sid, responseId, generation, reason }) {
      if (!currentTurn || !sameTurn(currentTurn.ref, { avatarSessionId: sid, responseId, generation })) return
      if (currentTurn.cancelRequested) return
      currentTurn.cancelRequested = true
      clearTurnTimers()
      sendCancel(currentTurn.ref, reason)
    },

    events: () => events,

    close: closeSession,
  }
  return session
}
