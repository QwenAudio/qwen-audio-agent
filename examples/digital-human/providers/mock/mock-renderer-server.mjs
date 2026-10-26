// Mock avatar renderer: a complete DHAV server (HTTP session management +
// input WSS + media WSS) that turns assistant reply PCM into synthetic
// paired audio/video. Same protocol surface as the M2 Python renderer, so
// the provider adapter and media adapter never know which one they drive.
//
// Synthetic media only: an audio-reactive I420 bar spectrum (see spectrum.mjs)
// paired with the echoed input audio. Fault injection covers the
// provider-contract failure taxonomy.

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  ControlOp, DhavError, RecordKind, INPUT_AUDIO_FORMAT,
  encodePairedAv, encodeMediaEnd, encodeMediaEvent, decodeRecord, decodeControl,
} from '../../protocol/dhav.mjs'
import { createSpectrumRenderer } from './spectrum.mjs'

const require = createRequire(import.meta.url)
const { WebSocketServer, WebSocket } = require('ws')

export const MOCK_PERSONAS = Object.freeze({
  'mock-default': Object.freeze({ avatarAssetId: 'mock-pattern', video: Object.freeze({ format: 'i420', width: 256, height: 256, fps: 25 }) }),
})

const FAULTS = ['first_media_timeout', 'media_stall', 'protocol_error', 'mid_turn_failure', 'channel_drop']
const FRAME_SAMPLES = 960 // 40 ms @ 24 kHz == 25 fps
// A realtime renderer is fed by a model that produces reply audio faster than
// realtime, so its input queue must absorb the whole turn (the excess over
// realtime is buffered here and rendered out at frame cadence). 120 s covers any
// realistic voice reply; the M2 renderer must honor the same contract.
const DEFAULT_ADMISSION_SECONDS = 120

export async function startMockRendererServer({
  host = '127.0.0.1', port = 0, personas = MOCK_PERSONAS, authToken = null, fault = null,
  heartbeatIntervalMs = 1000, admissionSeconds = DEFAULT_ADMISSION_SECONDS, log = () => {},
} = {}) {
  if (fault && !FAULTS.includes(fault)) throw new Error(`unknown fault ${fault}`)
  const admissionSamples = INPUT_AUDIO_FORMAT.sampleRate * admissionSeconds
  const sessions = new Map()
  let activeSessionId = null

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health/live') return send(200, { live: true })
    if (req.method === 'GET' && req.url === '/health/ready') return send(200, { ready: true, fault })
    if (req.method === 'POST' && req.url === '/v1/avatar/sessions') {
      if (authToken && req.headers.authorization !== `Bearer ${authToken}`) return send(401, { error: 'unauthorized' })
      let body = ''
      req.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy() })
      req.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return send(400, { error: 'malformed body' }) }
        const persona = personas[parsed?.personaId]
        if (!persona) return send(400, { error: 'unknown persona' })
        if (parsed.protocolVersion !== 1) return send(400, { error: 'unsupported protocolVersion' })
        if (activeSessionId && sessions.has(activeSessionId)) return send(409, { error: 'capacity_exhausted' })
        const session = createSession({ persona, personaId: parsed.personaId })
        sessions.set(session.id, session)
        activeSessionId = session.id
        log('session.created', { id: session.id, personaId: parsed.personaId })
        return send(201, session.publicDescription())
      })
      return
    }
    const match = req.method === 'DELETE' && req.url.match(/^\/v1\/avatar\/sessions\/([^/]+)$/)
    if (match) {
      const session = sessions.get(decodeURIComponent(match[1]))
      if (session) { session.destroy('session_deleted'); sessions.delete(session.id); if (activeSessionId === session.id) activeSessionId = null }
      res.writeHead(204).end()
      return
    }
    send(404, { error: 'not_found' })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal')
    const match = url.pathname.match(/^\/v1\/avatar\/sessions\/([^/]+)\/(input|media)$/)
    if (!match) { socket.destroy(); return }
    const session = sessions.get(decodeURIComponent(match[1]))
    const channel = match[2]
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!session || session[`${channel}Token`] !== token || session.destroyed) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => session.attach(channel, ws))
  })

  function createSession({ persona, personaId }) {
    const id = randomUUID()
    const inputToken = randomUUID()
    const mediaToken = randomUUID()
    const video = persona.video
    const frameIntervalMs = Math.round(1000 / video.fps)
    // Audio-reactive avatar video: a music-player-style bar spectrum driven by
    // the same PCM echoed back in each paired unit, so the picture tracks the
    // assistant voice and stays in sync with the audio by construction.
    const spectrum = createSpectrumRenderer({
      width: video.width, height: video.height, sampleRate: INPUT_AUDIO_FORMAT.sampleRate,
    })
    let inputSocket = null
    let mediaSocket = null
    let destroyed = false
    let readySent = false
    let turn = null // { ref, expectedSequence, consumedSamples, publishedUnits, firstMediaSent, finishing, cancelRequested, chunks: [], seen: Map }
    let synthesisTimer = null
    let heartbeatTimer = null
    let progressTimer = null

    const session = {
      id, inputToken, mediaToken,
      get destroyed() { return destroyed },
      publicDescription() {
        return {
          avatarSessionId: id,
          protocolVersion: 1,
          personaId,
          input: { url: `ws://${host}:${address().port}/v1/avatar/sessions/${id}/input`, token: inputToken },
          media: { url: `ws://${host}:${address().port}/v1/avatar/sessions/${id}/media`, token: mediaToken },
          video: { ...video },
          inputFormat: { ...INPUT_AUDIO_FORMAT },
        }
      },
      attach(channel, ws) {
        if (channel === 'input') { inputSocket = ws; ws.addEventListener('message', event => onInputMessage(ws, event)); ws.addEventListener('close', () => onChannelLost('input')) }
        else { mediaSocket = ws; ws.addEventListener('close', () => onChannelLost('media')) }
        log('channel.attached', { id, channel })
        maybeReady()
      },
      destroy(reason) {
        if (destroyed) return
        destroyed = true
        stopTimers()
        turn = null
        try { inputSocket?.terminate() } catch {}
        try { mediaSocket?.terminate() } catch {}
        log('session.destroyed', { id, reason })
      },
    }

    function maybeReady() {
      if (readySent || destroyed || !inputSocket || !mediaSocket) return
      readySent = true
      sendInput(encodeMediaEvent({ event: 'session.ready', avatarSessionId: id }))
      heartbeatTimer = setInterval(() => {
        sendInput(encodeMediaEvent({ event: 'heartbeat', ts: Date.now() }))
        sendMedia(encodeMediaEvent({ event: 'heartbeat', ts: Date.now() }))
      }, heartbeatIntervalMs)
      heartbeatTimer.unref?.()
    }

    function onChannelLost(channel) {
      if (destroyed) return
      if (channel === 'media' && turn && !turn.cancelRequested) {
        // Never render into a queue without a consumer.
        stopSynthesis()
        sendInput(encodeMediaEvent({ event: 'provider.error', turn: turn.ref, code: 'unavailable', message: 'media channel lost', rebuild: true }))
        turn = null
        return
      }
      session.destroy(`${channel}_lost`)
      sessions.delete(id)
      if (activeSessionId === id) activeSessionId = null
    }

    function sendInput(text) { if (inputSocket?.readyState === WebSocket.OPEN) inputSocket.send(text) }
    function sendMedia(data) {
      if (mediaSocket?.readyState !== WebSocket.OPEN) return false
      mediaSocket.send(data)
      return true
    }
    function stopTimers() { stopSynthesis(); clearInterval(progressTimer); clearInterval(heartbeatTimer) }
    function stopSynthesis() { clearInterval(synthesisTimer); synthesisTimer = null }

    function failTurn(code, message) {
      if (!turn) return
      const ref = turn.ref
      stopSynthesis()
      clearInterval(progressTimer)
      turn = null
      log('turn.failed', { id, code, message, responseId: ref.responseId })
      sendInput(encodeMediaEvent({ event: 'provider.error', turn: ref, code, message, rebuild: code !== 'protocol_error' }))
    }

    function onInputMessage(ws, { data }) {
      if (destroyed) return
      if (typeof data === 'string') { onControl(data); return }
      if (!turn || turn.cancelRequested) return
      let record
      try { record = decodeRecord(data) } catch (error) { failTurn('protocol_error', error.message); return }
      if (record.kind !== RecordKind.INPUT_PCM) { failTurn('protocol_error', `unexpected record kind ${record.kind} on input channel`); return }
      if (!sameTurn(record.header.turn, turn.ref)) {
        if (record.header.turn.generation < turn.ref.generation) return // stale generation, isolated
        failTurn('protocol_error', 'TurnRef mismatch on input channel')
        return
      }
      const { sequence } = record.header
      if (sequence === turn.expectedSequence) {
        const queued = turn.chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0)
        if (queued + record.header.samples > admissionSamples) { failTurn('capacity_exhausted', `input admission queue over ${admissionSeconds}s bound`); return }
        turn.chunks.push(Buffer.from(record.payload))
        turn.seen.set(sequence, record.payload)
        turn.expectedSequence++
        if (!synthesisTimer) startSynthesis()
      } else if (sequence < turn.expectedSequence) {
        const previous = turn.seen.get(sequence)
        if (!previous || !previous.equals(record.payload)) failTurn('protocol_error', `duplicate sequence ${sequence} with different content`)
      } else {
        failTurn('protocol_error', `sequence gap: expected ${turn.expectedSequence}, got ${sequence}`)
      }
    }

    function onControl(text) {
      let frame
      try { frame = decodeControl(text) } catch (error) { failTurn('protocol_error', error.message); return }
      if (frame.op === ControlOp.START) {
        if (turn) { failTurn('protocol_error', 'start while a turn is active'); return }
        if (!readySent) { failTurn('protocol_error', 'start before session.ready'); return }
        if (fault === 'protocol_error') { sendInput(encodeMediaEvent({ event: 'not.a.real.event' })); return }
        turn = { ref: { ...frame.turn }, expectedSequence: 0, consumedSamples: 0, publishedUnits: 0, firstMediaSent: false, finishing: false, cancelRequested: false, chunks: [], seen: new Map() }
        log('turn.started', { id, responseId: frame.turn.responseId, generation: frame.turn.generation })
        return
      }
      if (!turn) return
      if (frame.op === ControlOp.FINISH) {
        if (!sameTurn(frame.turn, turn.ref)) return
        if (turn.finishing) return
        const admittedSamples = turn.consumedSamples + turn.chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0)
        if (frame.lastAudioSequence !== turn.expectedSequence - 1 || frame.totalSamples !== admittedSamples) {
          failTurn('protocol_error', 'finish totals do not match admitted input')
          return
        }
        turn.finishing = true
        if (!synthesisTimer) startSynthesis()
        return
      }
      if (frame.op === ControlOp.CANCEL) {
        if (!sameTurn(frame.turn, turn.ref)) return
        if (turn.cancelRequested) return
        turn.cancelRequested = true
        stopSynthesis()
        clearInterval(progressTimer)
        const ref = turn.ref
        turn = null
        sendInput(encodeMediaEvent({ event: 'turn.cancelled', turn: ref, reason: frame.reason || 'user_interruption' }))
        log('turn.cancelled', { id, reason: frame.reason })
        return
      }
      if (frame.op === ControlOp.CLOSE) session.destroy('close_requested')
    }

    function startSynthesis() {
      if (fault === 'first_media_timeout') return // admit input but never publish
      synthesisTimer = setInterval(synthesizeFrame, frameIntervalMs)
      synthesisTimer.unref?.()
      progressTimer = setInterval(() => {
        if (turn && turn.firstMediaSent && fault !== 'media_stall') sendInput(encodeMediaEvent({ event: 'turn.progress', turn: turn.ref, unitsPublished: turn.publishedUnits }))
      }, 500)
      progressTimer.unref?.()
    }

    function synthesizeFrame() {
      if (destroyed || !turn) { stopSynthesis(); return }
      if (fault === 'media_stall' && turn.publishedUnits >= 1) { stopSynthesis(); return }
      if (mediaSocket?.readyState !== WebSocket.OPEN) return
      const pcm = takeSamples(FRAME_SAMPLES)
      if (!pcm) {
        if (turn.finishing) endTurn()
        else if (!synthesisNeeded()) stopSynthesis()
        return
      }
      publishUnit(pcm.samples, pcm.buffer, pcm.paddingSamples)
    }

    function synthesisNeeded() {
      return turn.chunks.length > 0 || turn.finishing
    }

    function takeSamples(max) {
      const available = turn.chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0)
      if (available === 0) {
        if (!turn.finishing) return null
        return null
      }
      // Leave partial input in the queue until it forms a frame. Consuming it
      // before this check silently lost short Realtime audio chunks.
      if (available < max && !turn.finishing) return null
      const count = Math.min(max, available)
      const buffer = Buffer.alloc(max * 2)
      let filled = 0
      while (filled < count && turn.chunks.length) {
        const chunk = turn.chunks[0]
        const take = Math.min(chunk.length, (count - filled) * 2)
        chunk.copy(buffer, filled * 2, 0, take)
        filled += take / 2
        if (take === chunk.length) turn.chunks.shift()
        else turn.chunks[0] = chunk.subarray(take)
      }
      const paddingSamples = max - filled
      turn.consumedSamples += filled
      return { samples: max, buffer, paddingSamples }
    }

    function publishUnit(samples, audioBuffer, paddingSamples) {
      const frameSequence = turn.publishedUnits
      const ptsUs = Math.round((turn.consumedSamples - (samples - paddingSamples)) * 1_000_000 / INPUT_AUDIO_FORMAT.sampleRate)
      // Feed this unit's PCM (s16le) into the visualizer before drawing the
      // frame it is paired with, so the spectrum reflects exactly this audio.
      const pcm = new Int16Array(audioBuffer.length >> 1)
      for (let i = 0; i < pcm.length; i++) pcm[i] = audioBuffer.readInt16LE(i * 2)
      spectrum.push(pcm)
      let record
      try {
        record = encodePairedAv({
          turn: turn.ref, sequence: frameSequence, ptsUs, durationUs: Math.round(samples * 1_000_000 / INPUT_AUDIO_FORMAT.sampleRate),
          sampleOffset: turn.consumedSamples - (samples - paddingSamples), samples, paddingSamples,
          silence: paddingSamples === samples,
          video: { format: 'i420', width: video.width, height: video.height, data: spectrum.frame() },
          audio: audioBuffer,
        })
      } catch (error) {
        if (error instanceof DhavError) failTurn('protocol_error', error.message)
        return
      }
      if (fault === 'mid_turn_failure' && frameSequence >= 3) {
        stopSynthesis()
        const ref = turn.ref
        turn = null
        sendInput(encodeMediaEvent({ event: 'provider.error', turn: ref, code: 'invalid_media', message: 'injected mid-turn failure', rebuild: true }))
        try { mediaSocket?.terminate() } catch {}
        return
      }
      if (!sendMedia(record)) return
      turn.publishedUnits++
      if (!turn.firstMediaSent) {
        turn.firstMediaSent = true
        sendInput(encodeMediaEvent({ event: 'turn.first_media', turn: turn.ref }))
      }
      if (fault === 'channel_drop' && turn.publishedUnits >= 2) {
        const ref = turn.ref
        turn = null
        stopSynthesis()
        sendInput(encodeMediaEvent({ event: 'turn.cancelled', turn: ref, reason: 'transport_lost' }))
        try { inputSocket?.terminate() } catch {}
        session.destroy('fault_channel_drop')
        sessions.delete(id)
        if (activeSessionId === id) activeSessionId = null
      }
    }

    function endTurn() {
      stopSynthesis()
      clearInterval(progressTimer)
      const ref = turn.ref
      sendMedia(encodeMediaEnd({ turn: ref, lastSequence: turn.publishedUnits - 1, reason: 'finished' }))
      sendInput(encodeMediaEvent({ event: 'turn.completed', turn: ref, lastSequence: turn.publishedUnits - 1 }))
      log('turn.completed', { id, responseId: ref.responseId, units: turn.publishedUnits })
      turn = null
    }

    return session
  }

  function sameTurn(a, b) {
    return Boolean(a && b && a.avatarSessionId === b.avatarSessionId && a.responseId === b.responseId && a.generation === b.generation)
  }

  function address() { return server.address() }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const bound = server.address()
  return {
    url: `http://${bound.address}:${bound.port}`,
    wsUrl: `ws://${bound.address}:${bound.port}`,
    port: bound.port,
    fault,
    get sessionCount() { return sessions.size },
    async close() {
      for (const session of sessions.values()) session.destroy('server_close')
      sessions.clear()
      activeSessionId = null
      await new Promise(resolve => wss.close(resolve))
      await new Promise(resolve => server.close(resolve))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.DH_MOCK_RENDERER_HOST || '127.0.0.1'
  const port = Number(process.env.DH_MOCK_RENDERER_PORT || 18901)
  const fault = process.env.DH_MOCK_FAULT || null
  const started = await startMockRendererServer({ host, port, fault, log: (name, fields) => console.log(`[mock-renderer] ${name}`, fields) })
  console.log(`[mock-renderer] listening on ${started.url}${fault ? ` (fault: ${fault})` : ''}`)
}
