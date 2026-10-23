// DHAV is one example-local renderer adapter, not a Gateway extension.
// The provider's long-lived and scoped credentials never reach the browser.
import { WebSocket } from 'ws'
import { createDhavProvider } from '../../providers/dhav-provider.mjs'
import { createFramedAvSource } from '../../media/framed-av-source.mjs'
import { encodePairedAv, encodeMediaEnd } from '../../protocol/dhav.mjs'

const MAX_QUEUED_BYTES = 512 * 1024
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const sameTurn = (a, b) => a && b && a.responseId === b.responseId && a.generation === b.generation

export async function attachDhavRenderer(socket, {
  rendererUrl, rendererToken, persona, providerOptions = {},
}) {
  const abort = new AbortController()
  let session, source, current, closed = false, ready = false
  let generation = -1, queuedBytes = 0, chain = Promise.resolve()
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
        }
        return
      }
      if (message.type === 'turn.start') {
        if (message.generation <= generation) return
        if (current && !current.inputEnded) throw new Error('previous input is active')
        generation = message.generation
        current = { avatarSessionId: session.avatarSessionId, responseId: message.responseId, generation,
          sequence: 0, sampleOffset: 0, inputEnded: false }
      } else if (!sameTurn(current, message)) return // late data after cancel
      if (queuedBytes + raw.length > MAX_QUEUED_BYTES) throw new Error('input backpressure')
      const turn = current
      queuedBytes += raw.length
      chain = chain.then(async () => {
        if (closed || current !== turn) return
        if (message.type === 'turn.start') await session.startTurn(turn)
        else if (message.type === 'audio.append') {
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
    session = await provider.openSession({ persona: { personaId: persona }, signal: abort.signal })
    if (closed) { await session.close(); return close }
    void (async () => {
      for await (const event of session.events()) {
        if (closed) return
        if (event.type === 'session.ready') resolveControlReady()
        else if (event.type === 'provider.error') {
          rejectControlReady(new Error('renderer unavailable'))
          fail(event.code)
        }
      }
    })().catch(() => fail())
    source = createFramedAvSource({
      binding: session.mediaBinding,
      onUnit: unit => {
        if (sameTurn(current, unit.turn)) send(encodePairedAv(unit))
      },
      onEvent: event => {
        if (event.type === 'media_end' && sameTurn(current, event.turn)) send(encodeMediaEnd(event))
      },
      onError: () => fail('invalid_media'), onClose: () => fail(),
    })
    await Promise.all([controlReady, source.ready])
    if (!closed) {
      ready = true
      send(JSON.stringify({ type: 'session.ready', avatarSessionId: session.avatarSessionId }))
    }
  } catch { fail() }
  return close
}
