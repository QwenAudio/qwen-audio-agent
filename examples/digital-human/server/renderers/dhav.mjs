// DHAV is one example-local renderer adapter, not a Gateway extension.
// The provider's long-lived and scoped credentials never reach the browser.
import { WebSocket } from 'ws'
import { createDhavProvider } from '../../providers/dhav-provider.mjs'
import { createFramedAvSource } from '../../media/framed-av-source.mjs'
import { encodePairedAv, encodeMediaEnd } from '../../protocol/dhav.mjs'

const MAX_QUEUED_BYTES = 512 * 1024
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const sameTurn = (a, b) => a && b && a.responseId === b.responseId && a.generation === b.generation

// The renderer only produces paired A/V while a turn is being fed audio, so
// without this the canvas freezes on the last spoken frame the moment a reply
// ends or is interrupted. A silence-fed turn keeps it animating between replies.
const IDLE_RESPONSE_ID = 'dh-idle'
// 40 ms blocks match the renderer's 24 kHz / 25 fps cadence.
const IDLE_FEED_INTERVAL_MS = 40
const IDLE_SAMPLES = 960
const IDLE_SILENCE = Buffer.alloc(IDLE_SAMPLES * 2)
// Idle is cosmetic, so a failed idle turn restarts rather than staying dead —
// but boundedly and with backoff, so a renderer that rejects every idle turn
// cannot hot-loop the single session at the feed cadence. The budget re-arms
// only once an idle turn has survived long enough to count as healthy.
const MAX_IDLE_RESTARTS = 3
const IDLE_RESTART_BACKOFF_MS = 500
const IDLE_HEALTHY_MS = 5000
// Idle generations live in a reserved band above anything the browser controller
// mints (it increments once per response). Cancelling a real turn quarantines
// every generation at or below its own in the media source, which must never
// reach idle frames.
const IDLE_GENERATION_BASE = 0x40000000

export async function attachDhavRenderer(socket, {
  rendererUrl, rendererToken, persona, providerOptions = {},
}) {
  const abort = new AbortController()
  let session, source, current, closed = false, ready = false
  let generation = -1, queuedBytes = 0, chain = Promise.resolve()
  let idle = null, idleTimer = null, idleEpoch = 0, idleFailures = 0, idleEnabled = false
  let resolveControlReady, rejectControlReady
  const controlReady = new Promise((resolve, reject) => {
    resolveControlReady = resolve
    rejectControlReady = reject
  })
  controlReady.catch(() => {})

  const close = async () => {
    if (closed) return
    closed = true
    current = null
    // Stop the silence feeder. session.close() below sends op:'close', which
    // tears down the renderer-side idle turn, so no cancel is published here.
    clearIdleTimers()
    abort.abort()
    rejectControlReady(new Error('renderer connection closed'))
    source?.close()
    await session?.close().catch(() => {})
  }
  const send = data => {
    if (closed || socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount + (typeof data === 'string' ? Buffer.byteLength(data) : data.length) > MAX_OUTPUT_BYTES) {
      fail('capacity_exhausted')
      return
    }
    socket.send(data)
  }
  const fail = (code = 'unavailable') => {
    if (closed) return
    // Do not expose remote URLs, provider error bodies, or credentials.
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
      type: 'renderer.error', code, message: `Renderer unavailable (${code})`,
      ...(current ? { responseId: current.responseId, generation: current.generation } : {}),
    }))
    socket.close(1011, 'renderer unavailable')
    void close()
  }
  socket.on('close', () => { void close() })
  socket.on('error', () => { void close() })
  socket.on('message', (raw, binary) => {
    if (closed) return
    let message
    try {
      if (binary || raw.length > MAX_QUEUED_BYTES) throw new Error('invalid message')
      message = JSON.parse(raw.toString())
      if (!ready || typeof message.responseId !== 'string' || !message.responseId || message.responseId.length > 256
        || !Number.isSafeInteger(message.generation) || message.generation < 0) throw new Error('invalid turn')
      if (!['turn.start', 'audio.append', 'audio.end', 'turn.cancel'].includes(message.type)) throw new Error('unknown command')
      // Cancellation fences queued input synchronously, ahead of network writes.
      if (message.type === 'turn.cancel') {
        if (sameTurn(current, message)) {
          const turn = current
          current = null
          source.clear(turn.generation)
          void session.interruptTurn({ ...turn, reason: message.reason || 'user_interruption' }).catch(() => fail())
          // A barge-in returns the avatar to idle animation instead of freezing
          // it on the interrupted frame.
          scheduleIdle()
        }
        return
      }
      if (message.type === 'turn.start') {
        if (message.generation <= generation) return
        if (current && !current.inputEnded) throw new Error('previous input is active')
        // Synchronous, ahead of the queued startTurn: a real reply supersedes
        // idle, and a silence block landing after the renderer switched turns
        // would fail the whole connection on a TurnRef mismatch.
        stopIdle()
        generation = message.generation
        current = { avatarSessionId: session.avatarSessionId, responseId: message.responseId, generation,
          sequence: 0, sampleOffset: 0, inputEnded: false }
      } else if (!sameTurn(current, message)) return // late data after cancel
      if (queuedBytes + raw.length > MAX_QUEUED_BYTES) throw new Error('input backpressure')
      const turn = current
      queuedBytes += raw.length
      chain = chain.then(async () => {
        if (closed || current !== turn) return
        if (message.type === 'turn.start') {
          await session.startTurn(turn)
          // A real turn ran, so the session is healthy: re-arm idle restarts.
          idleFailures = 0
        } else if (message.type === 'audio.append') {
          if (turn.inputEnded || message.sampleRate !== 24000 || typeof message.audio !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.audio)) throw new Error('invalid PCM')
          const data = Buffer.from(message.audio, 'base64')
          if (!data.length || data.length % 2) throw new Error('invalid PCM length')
          await session.appendAudio({ ...turn, data })
          turn.sequence++
          turn.sampleOffset += data.length / 2
        } else if (message.type === 'audio.end') {
          if (turn.inputEnded) return
          turn.inputEnded = true
          await session.finishTurn({ ...turn, lastAudioSequence: turn.sequence - 1, totalSamples: turn.sampleOffset })
        }
      }).catch(() => fail('protocol_error')).finally(() => { queuedBytes -= raw.length })
    } catch { fail('protocol_error') }
  })

  try {
    const provider = createDhavProvider({ ...providerOptions, rendererBaseUrl: rendererUrl, authToken: rendererToken })
    // Idle is opt-in per renderer: a vendor whose service animates on its own
    // (a continuous RTC track) reports no idle capability and must not be fed
    // silence turns.
    idleEnabled = providerOptions?.idle !== false && (await provider.capabilities()).idle === true
    session = await provider.openSession({ persona: { personaId: persona }, signal: abort.signal })
    if (closed) { await session.close(); return close }
    void (async () => {
      for await (const event of session.events()) {
        if (closed) return
        if (event.type === 'session.ready') resolveControlReady()
        else if (event.type === 'provider.error') {
          // A failed idle turn is cosmetic: drop the feeder and keep the session
          // for real replies. Only a genuinely dead session fails the bridge.
          if (event.turn?.responseId === IDLE_RESPONSE_ID && session.state !== 'closed') {
            stopIdle()
            restartIdleBounded()
            continue
          }
          rejectControlReady(new Error('renderer unavailable'))
          fail(event.code)
        }
      }
    })().catch(() => fail())
    source = createFramedAvSource({
      binding: session.mediaBinding,
      onUnit: unit => {
        if (sameTurn(current, unit.turn)) { send(encodePairedAv(unit)); return }
        // Stamped here: the renderer does not know a silence-fed turn is idle,
        // and the browser needs the flag to keep it off the playback receipts.
        if (idle && sameTurn(idle.ref, unit.turn)) send(encodePairedAv({ ...unit, idle: true }))
      },
      onEvent: event => {
        if (event.type !== 'media_end') return
        if (sameTurn(current, event.turn)) {
          send(encodeMediaEnd(event))
          // The reply is fully delivered, so the avatar may return to idle.
          current = null
          scheduleIdle()
          return
        }
        if (idle && sameTurn(idle.ref, event.turn)) { stopIdle(); restartIdleBounded() }
      },
      onError: () => fail('invalid_media'), onClose: () => fail(),
    })
    await Promise.all([controlReady, source.ready])
    if (!closed) {
      ready = true
      send(JSON.stringify({ type: 'session.ready', avatarSessionId: session.avatarSessionId }))
      scheduleIdle()
    }
  } catch { fail() }

  // -- idle turn ---------------------------------------------------------------
  // Control-plane only: its frames are stamped idle and painted straight to the
  // canvas, its silence never reaches the audio queue, and it never advances a
  // playback receipt or the turn timeline.

  function idleEligible() {
    return idleEnabled && ready && !closed && !current && !idle && Boolean(session)
  }

  // Deferred so the synchronous parts of a supersede or cancel (which set
  // `current`) settle first. The delay also carries the restart backoff.
  function scheduleIdle(delayMs = 0) {
    if (!idleEnabled || closed || idleTimer) return
    idleTimer = setTimeout(() => { idleTimer = null; void startIdle() }, delayMs)
    idleTimer.unref?.()
  }

  function clearIdleTimers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (idle?.timer) clearTimeout(idle.timer)
    idle = null
  }

  function stopIdle() {
    const turn = idle
    clearIdleTimers()
    // No renderer-side cancel: the next real startTurn supersedes it on the same
    // ordered control channel, and session.close() ends it otherwise.
    if (turn) source?.forget(turn.ref)
  }

  async function startIdle() {
    if (!idleEligible()) return
    const ref = {
      avatarSessionId: session.avatarSessionId,
      responseId: IDLE_RESPONSE_ID,
      generation: IDLE_GENERATION_BASE + (++idleEpoch),
    }
    // Register before the await: a real turn landing while startTurn is in flight
    // must find this descriptor so stopIdle() fences its frames, instead of
    // leaving them flowing under a generation nothing owns.
    idle = { ref, sequence: 0, sampleOffset: 0, timer: null, startedAt: Date.now() }
    try {
      await session.startTurn(ref)
    } catch {
      stopIdle()
      restartIdleBounded()
      return
    }
    if (idle?.ref !== ref || closed || current) return
    feedIdle()
  }

  function feedIdle() {
    const turn = idle
    if (!turn) return
    const tick = async () => {
      if (idle !== turn || closed) return
      try {
        // Serialized: each block is acknowledged before the next is scheduled, so
        // the provider's strict per-turn sequence never sees a gap.
        await session.appendAudio({ ...turn.ref, sequence: turn.sequence, sampleOffset: turn.sampleOffset, data: IDLE_SILENCE })
        if (idle !== turn) return
        turn.sequence += 1
        turn.sampleOffset += IDLE_SAMPLES
        // Re-arm only once this idle turn has proven healthy. Resetting on every
        // block would make the bound useless against a renderer that accepts a
        // turn and then errors on it, spinning the loop at the feed cadence.
        if (idleFailures && Date.now() - turn.startedAt >= IDLE_HEALTHY_MS) idleFailures = 0
      } catch {
        stopIdle()
        restartIdleBounded()
        return
      }
      if (idle === turn && !closed) {
        turn.timer = setTimeout(tick, IDLE_FEED_INTERVAL_MS)
        turn.timer.unref?.()
      }
    }
    turn.timer = setTimeout(tick, IDLE_FEED_INTERVAL_MS)
    turn.timer.unref?.()
  }

  function restartIdleBounded() {
    if (idleFailures++ >= MAX_IDLE_RESTARTS) return
    scheduleIdle(IDLE_RESTART_BACKOFF_MS * 2 ** (idleFailures - 1))
  }

  return close
}
