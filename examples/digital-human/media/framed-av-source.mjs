// DHAV media source used by the example-local renderer bridge. Neither this
// module nor its media bytes are loaded by the Gateway or its WebRTC worker.
//
// Dependencies resolve from the example's own node_modules (createRequire on
// this file's URL), never from accidental framework hoisting.

import { createRequire } from 'node:module'
import { RecordKind, decodeRecord, decodeMediaEvent } from '../protocol/dhav.mjs'

const require = createRequire(import.meta.url)

export const ADAPTER_ID = 'dhav-framed-av'

// onUnit(MediaUnit)  — normalized paired audio+video unit
// onEvent({ type })  — 'media_end' {turn, lastSequence, reason} | 'heartbeat'
// onError(error)     — protocol failures; caller must close
// onClose()          — media channel closed by the renderer
export function createFramedAvSource({ binding, onUnit, onEvent = () => {}, onError = () => {}, onClose = () => {}, WebSocket, connectTimeoutMs = 10000 }) {
  if (binding?.protocol !== 'dhav' || binding.protocolVersion !== 1) throw new Error('binding must be dhav v1')
  if (typeof binding.media?.url !== 'string' || !/^wss?:\/\//.test(binding.media.url)) throw new Error('binding.media.url must be ws(s)')
  const Socket = WebSocket || require('ws').WebSocket
  const socket = new Socket(binding.media.url, { headers: { authorization: `Bearer ${binding.media.token}` } })
  socket.binaryType = 'nodebuffer'
  let closed = false
  let quarantinedGeneration = -1
  const expectedSequence = new Map() // `${responseId}:${generation}` -> next sequence

  // The renderer accepts the media-channel join itself; a successful open
  // with a valid scoped token is the readiness signal for this adapter.
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('media channel connect timed out')), connectTimeoutMs)
    timer.unref?.()
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('media channel error')) })
  })
  ready.catch(() => {})

  socket.addEventListener('message', ({ data }) => {
    if (closed) return
    if (typeof data === 'string') {
      try {
        const frame = decodeMediaEvent(data)
        if (frame.event === 'heartbeat') onEvent({ type: 'heartbeat' })
      } catch { /* ignore malformed keepalives; binary path enforces the protocol */ }
      return
    }
    let record
    try { record = decodeRecord(data) } catch (error) { onError(error); return }
    const { turn } = record.header
    if (turn.generation <= quarantinedGeneration) return // stale generation, isolated
    if (record.kind === RecordKind.PAIRED_AV) {
      const key = `${turn.responseId}:${turn.generation}`
      const expected = expectedSequence.get(key)
      if (expected === undefined) expectedSequence.set(key, record.header.sequence + 1)
      else if (record.header.sequence === expected) expectedSequence.set(key, expected + 1)
      else if (record.header.sequence > expected) { onError(new Error(`media sequence gap for ${key}: expected ${expected}, got ${record.header.sequence}`)); return }
      else return // duplicate below expectation
      const { header, audio, video } = record
      onUnit({
        turn,
        sequence: header.sequence,
        ptsUs: header.ptsUs,
        durationUs: header.durationUs,
        sampleOffset: header.sampleOffset,
        samples: header.samples,
        paddingSamples: header.paddingSamples,
        silence: header.silence,
        idle: header.idle,
        audioFormat: header.format,
        video: { format: 'i420', width: header.video.width, height: header.video.height, data: video },
        audio,
      })
    } else if (record.kind === RecordKind.MEDIA_END) {
      expectedSequence.delete(`${turn.responseId}:${turn.generation}`)
      onEvent({ type: 'media_end', turn, lastSequence: record.header.lastSequence, reason: record.header.reason })
    } else {
      onError(new Error(`unexpected record kind ${record.kind} on media channel`))
    }
  })
  socket.addEventListener('close', () => { if (!closed) onClose() })
  socket.addEventListener('error', () => { if (!closed) onError(new Error('media channel error')) })

  return {
    adapterId: ADAPTER_ID,
    ready,
    clear(generation) {
      // Quarantine everything up to this generation; late frames from
      // cancelled turns must never be republished under a new generation.
      quarantinedGeneration = Math.max(quarantinedGeneration, generation)
      for (const key of expectedSequence.keys()) {
        if (Number(key.slice(key.lastIndexOf(':') + 1)) <= quarantinedGeneration) expectedSequence.delete(key)
      }
    },
    // Drop one turn's sequence bookkeeping without quarantining its generation.
    // clear() cannot serve here: a turn that is superseded rather than cancelled
    // may share its generation band with turns that are still live.
    forget(turn) {
      if (turn?.responseId !== undefined) expectedSequence.delete(`${turn.responseId}:${turn.generation}`)
    },
    close() {
      if (closed) return
      closed = true
      try { socket.close() } catch { socket.terminate() }
    },
  }
}
