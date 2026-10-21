import { PcmResampler } from './pcm.mjs'

// Avatar A/V scheduler: pairs renderer-produced audio with video and drives the
// video frames off the audio master clock. Audio is handed back to the media
// engine's existing response queue (so output.started/drained, the browser's
// AnalyserNode playback detection and playback receipts all keep working
// unchanged); video frames are held in a small pts-ordered queue and popped as
// the audio clock advances. Frames are I420 and are published verbatim to the
// RTCVideoSource. Nothing here touches the model, tools or session history.
//
// The host interface is intentionally narrow so this stays testable without a
// real RTCPeerConnection:
//   beginResponse(responseId)          — register a response in the audio queue
//   enqueueAudio(responseId, samples)  — Int16Array @ 48kHz into the audio queue
//   finishResponse(responseId)         — mark the audio response complete
//   blockResponse(responseId, block)   — discard queued audio; `block` also
//                                        refuses further plain-audio egress
//   publishFrame({width,height,data})  — RTCVideoSource.onFrame(I420)
//   emit(op, {responseId, generation}) — 'first_media' | 'drained' feedback

const OUTPUT_SAMPLE_RATE = 48000
// The renderer echoes audio at realtime while the gateway's audio pump consumes a
// touch slower (a fixed 480 samples per 10 ms tick that drifts under load), so the
// renderer's video pts steadily leads the playback clock — tens of ms per second,
// reaching a couple of seconds over a long turn. Those leading frames are FUTURE
// frames that must be held until the clock reaches them; shedding them freezes the
// video mid-turn (the oldest/due-soonest frame is dropped before it can publish).
// 128 frames (~5 s at 25 fps) comfortably exceeds that lead, so the queue absorbs
// normal drift and the shed in appendUnit only fires as a runaway-memory valve.
const MAX_PENDING_FRAMES = 128

function decodeS16le(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length % 2) throw new TypeError('PCM16 requires an even byte length')
  const samples = new Int16Array(bytes.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  return samples
}

export class AvatarAvScheduler {
  constructor(host = {}) {
    this.host = host
    this.responses = new Map() // responseId -> { generation, converter, sampleRate, firstMediaFired, finished }
    this.frames = [] // pts-ordered { responseId, generation, ptsUs, width, height, data }
    this.clockUs = 0
    this.activeResponseId = null
    this.closed = false
  }

  begin(turn, format, idle = false) {
    if (this.closed || !turn) return
    const responseId = String(turn.responseId || '')
    const generation = Number(turn.generation) || 0
    if (!responseId) return
    const sampleRate = Number(format?.sampleRate) || OUTPUT_SAMPLE_RATE
    const response = this.responses.get(responseId)
    if (response) {
      // A re-begun response keeps its clock but rebinds to the new generation.
      response.generation = generation
      return
    }
    // An idle turn carries no reply audio: it never enters the audio queue (so
    // its silence cannot trip the browser's energy-gated playback receipts) and
    // its frames are published on arrival rather than gated by the audio clock.
    const isIdle = idle === true
    this.responses.set(responseId, {
      generation,
      sampleRate,
      converter: isIdle || sampleRate === OUTPUT_SAMPLE_RATE ? null : new PcmResampler(sampleRate, OUTPUT_SAMPLE_RATE),
      firstMediaFired: false,
      inputSealed: false,
      ended: false,
      idle: isIdle,
    })
    this.activeResponseId = responseId
    if (!isIdle) this.host.beginResponse?.(responseId)
  }

  appendUnit(unit) {
    if (this.closed || !unit) return
    const responseId = String(unit.turn?.responseId || '')
    const generation = Number(unit.turn?.generation) || 0
    const response = this.responses.get(responseId)
    // Unknown or stale-generation units are dropped: a cancelled turn's late
    // frames must never be republished under a newer generation.
    if (!response || generation < response.generation) return
    if (generation > response.generation) return

    // Idle frames publish on arrival: the renderer paces them at realtime
    // (25 fps), there is no paired audio to gate against, and an idle turn
    // intentionally does not advance the audio master clock (see begin()).
    if (response.idle) {
      const idleVideo = unit.video
      if (idleVideo?.data?.length) {
        try {
          this.host.publishFrame?.({
            width: idleVideo.width,
            height: idleVideo.height,
            data: idleVideo.data,
            ptsUs: Number(unit.ptsUs) || 0,
          })
        } catch {
          this.host.emit?.('error', { responseId, generation, code: 'invalid_media' })
        }
      }
      return
    }

    if (unit.audio?.length) {
      try {
        const input = decodeS16le(unit.audio)
        const samples = response.converter ? response.converter.push(input, unit.audioFormat?.channels || 1) : input
        if (samples.length) this.host.enqueueAudio?.(responseId, samples)
      } catch {
        this.host.emit?.('error', { responseId, generation, code: 'invalid_media' })
        return
      }
    }

    const video = unit.video
    if (video?.data?.length) {
      const frame = {
        responseId,
        generation,
        ptsUs: Number(unit.ptsUs) || 0,
        width: video.width,
        height: video.height,
        data: video.data,
      }
      // DHAV delivers units in sequence order, which is normally pts order, but
      // insert by pts so the publish loop can pop strictly from the front.
      let index = this.frames.length
      while (index > 0 && this.frames[index - 1].ptsUs > frame.ptsUs) index--
      this.frames.splice(index, 0, frame)
      while (this.frames.length > MAX_PENDING_FRAMES) this.frames.shift()
    }
  }

  // Model finished producing source audio (dh.finish). This only seals the
  // renderer's input; it does NOT end playback. The renderer echoes the audio
  // back as paired A/V at realtime, far slower than the model generated it, so
  // the playback end marker is deferred until the renderer's media_end. Ending
  // here would drain the response after only ~1/5 of the audio (the model's
  // speedup over realtime) and discard the rest.
  finish(turn) {
    if (this.closed || !turn) return
    const responseId = String(turn.responseId || '')
    const response = this.responses.get(responseId)
    if (!response || response.inputSealed) return
    response.inputSealed = true
  }

  // Renderer finished echoing every paired A/V unit of this turn (media_end).
  // This is the authoritative "all content generated" signal, so it — not the
  // model's response.done — flushes the resampler tail and enqueues the end
  // marker that lets the pump drain playback at the correct realtime moment.
  mediaEnd(turn) {
    if (this.closed || !turn) return
    const responseId = String(turn.responseId || '')
    const response = this.responses.get(responseId)
    if (!response || response.ended) return
    response.ended = true
    // An idle turn is cancelled, never finished. A stray media_end must not
    // flush audio or enqueue a playback end marker for a silent turn.
    if (response.idle) return
    if (response.converter) {
      try {
        const tail = response.converter.finish()
        if (tail.length) this.host.enqueueAudio?.(responseId, tail)
      } catch { /* a resampler flush failure must not block the end marker */ }
    }
    this.host.finishResponse?.(responseId)
  }

  // Quarantine every response at or below `generation`. `block` decides whether
  // the response's plain-audio egress is refused too: a barge-in cancel wants it
  // refused (the model keeps streaming a reply nobody will hear), while a
  // pre-commit renderer fallback must leave it open, because the orchestrator
  // replays the buffered model audio under this very responseId.
  clear(generation, block = true) {
    if (this.closed) return
    const boundary = Number(generation) || 0
    this.frames = this.frames.filter(frame => frame.generation > boundary)
    for (const [responseId, response] of this.responses) {
      if (response.generation <= boundary) {
        this.responses.delete(responseId)
        if (this.activeResponseId === responseId) this.activeResponseId = null
        this.host.blockResponse?.(responseId, block)
      }
    }
  }

  // Called by the media pump after it has pulled `filledSamples` @48kHz from the
  // audio queue. `drainedResponseId` is set when the pump consumed an end marker.
  onAudioPumped(filledSamples, drainedResponseId) {
    if (this.closed) return
    if (filledSamples > 0) this.clockUs += (filledSamples / OUTPUT_SAMPLE_RATE) * 1e6
    this.#publishDueFrames()
    if (drainedResponseId && this.responses.has(drainedResponseId)) {
      // Flush any trailing frames of the drained response, then report drained
      // so the selector can advance to TERMINAL once the client receipt lands.
      const generation = this.responses.get(drainedResponseId).generation
      this.#flushResponse(drainedResponseId)
      this.responses.delete(drainedResponseId)
      if (this.activeResponseId === drainedResponseId) this.activeResponseId = null
      this.host.emit?.('drained', { responseId: drainedResponseId, generation })
    }
  }

  #publishDueFrames() {
    while (this.frames.length && this.frames[0].ptsUs <= this.clockUs) {
      const frame = this.frames.shift()
      const response = this.responses.get(frame.responseId)
      if (!response || frame.generation < response.generation) continue
      try {
        this.host.publishFrame?.({ width: frame.width, height: frame.height, data: frame.data, ptsUs: frame.ptsUs })
      } catch {
        this.host.emit?.('error', { responseId: frame.responseId, generation: frame.generation, code: 'invalid_media' })
        continue
      }
      if (!response.firstMediaFired) {
        response.firstMediaFired = true
        this.host.emit?.('first_media', { responseId: frame.responseId, generation: frame.generation })
      }
    }
  }

  #flushResponse(responseId) {
    const remaining = this.frames.filter(frame => frame.responseId === responseId)
    this.frames = this.frames.filter(frame => frame.responseId !== responseId)
    for (const frame of remaining) {
      try {
        this.host.publishFrame?.({ width: frame.width, height: frame.height, data: frame.data })
      } catch { break }
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.frames = []
    this.responses.clear()
    this.activeResponseId = null
  }
}
