import { createRequire } from 'node:module'
import { requireWebRtcDependencies } from '../../../../shared/gateway/webrtc.mjs'
import { PcmResampler, decodePcm, encodePcm } from './pcm.mjs'
import { rtcError } from './config.mjs'

const requireExtension = createRequire(import.meta.url)
let native

export function isReliableOrderedChannel(channel) {
  // node-webrtc exposes the native unset uint16 sentinel as 65535, whereas
  // browser implementations expose null for unlimited retransmission.
  const unlimited = value => value == null || value === 65535
  return channel.ordered === true
    && unlimited(channel.maxRetransmits)
    && unlimited(channel.maxPacketLifeTime)
}

export function loadWebRtcNative() {
  if (native) return native
  try {
    const { entryPath, apiVersion } = requireWebRtcDependencies()
    const extension = requireExtension(entryPath)
    if (extension.apiVersion !== apiVersion || typeof extension.loadNative !== 'function') {
      throw Object.assign(new Error('Incompatible qwen-audio-agent-webrtc entry point. Update the Gateway and extension together.'), { code: 'webrtc_extension_incompatible' })
    }
    const loaded = extension.loadNative()
    if (typeof loaded?.rtc?.RTCPeerConnection !== 'function' || !loaded.rtc.nonstandard || typeof loaded.sharp !== 'function') {
      throw Object.assign(new Error('Invalid qwen-audio-agent-webrtc media implementation.'), { code: 'webrtc_extension_incompatible' })
    }
    native = loaded
    return native
  } catch (error) {
    if (error.code?.startsWith('webrtc_')) throw rtcError(503, error.code, error.message)
    throw rtcError(503, 'webrtc_extension_load_failed', 'Cannot load qwen-audio-agent-webrtc. Reinstall the extension for this Node.js version and operating system.')
  }
}

export function waitForIce(pc, timeoutMs = 10000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', changed)
      pc.removeEventListener('connectionstatechange', changed)
      error ? reject(error) : resolve()
    }
    const changed = () => {
      if (pc.connectionState === 'closed') finish(new Error('peer closed during negotiation'))
      else if (pc.iceGatheringState === 'complete') finish()
    }
    const timer = setTimeout(() => finish(rtcError(504, 'ice_timeout', 'ICE gathering timed out')), timeoutMs)
    pc.addEventListener('icegatheringstatechange', changed)
    pc.addEventListener('connectionstatechange', changed)
    changed()
  })
}

export class NativeWebRtcMedia {
  constructor({ iceServers = [], iceTransportPolicy = 'all', video = false, inputSampleRate = 16000, loadNative = loadWebRtcNative } = {}) {
    const { rtc, sharp } = loadNative()
    this.rtc = rtc
    this.sharp = sharp
    this.video = video
    this.inputSampleRate = inputSampleRate
    this.pc = new rtc.RTCPeerConnection({ iceServers, iceTransportPolicy })
    this.source = new rtc.nonstandard.RTCAudioSource()
    this.track = this.source.createTrack()
    this.pc.addTrack(this.track)
    this.channels = new Set()
    this.sinks = []
    this.queue = []
    this.queuedSamples = 0
    this.responses = new Map()
    this.known = new Set()
    this.blocked = new Set()
    this.closed = false
    this.opened = false
    this.lastImageAt = 0
    this.imageBusy = false
    this.audioTracks = 0
    this.videoTracks = 0
    this.events = this.pc.createDataChannel('txt', { ordered: true })
    this.bindChannel(this.events, true)
    this.pc.ondatachannel = ({ channel }) => this.bindChannel(channel, false)
    this.pc.ontrack = ({ track }) => this.receiveTrack(track)
    this.pc.onconnectionstatechange = () => {
      clearTimeout(this.disconnectedTimer)
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.fail('WebRTC transport closed')
      else if (this.pc.connectionState === 'disconnected') this.disconnectedTimer = setTimeout(() => this.fail('WebRTC disconnected'), 10000)
    }
    this.tick = setInterval(() => this.pump(), 10)
    this.tick.unref?.()
  }

  bindChannel(channel, outbound) {
    if (this.channels.size >= 2 || !isReliableOrderedChannel(channel)) {
      channel.close()
      return
    }
    this.channels.add(channel)
    channel.onmessage = ({ data }) => this.onEvent?.(data)
    channel.onclose = () => { if (!this.closed) this.fail('data channel closed') }
    channel.onerror = () => this.fail('data channel failed')
    channel.onopen = () => {
      if (outbound && !this.opened) {
        this.opened = true
        this.onOpen?.()
      }
    }
  }

  send(event) {
    if (this.closed || this.events.readyState !== 'open') return
    if (this.events.bufferedAmount > 1024 * 1024) return this.fail('slow data channel consumer')
    try { this.events.send(JSON.stringify(event)) } catch { this.fail('data channel send failed') }
  }

  connected() { return !this.closed && this.pc.connectionState === 'connected' && this.events.readyState === 'open' }

  async answer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    await waitForIce(this.pc)
    if (this.closed) throw new Error('peer closed')
    return this.pc.localDescription.sdp
  }

  receiveTrack(track) {
    if (track.kind === 'audio' && this.audioTracks++ === 0) {
      const sink = new this.rtc.nonstandard.RTCAudioSink(track)
      this.sinks.push(sink)
      let converter
      sink.ondata = data => {
        if (this.closed) return
        try {
          if (data.bitsPerSample !== 16) throw new Error('PCM16 input required')
          if (!converter || converter.from !== data.sampleRate || converter.to !== this.inputSampleRate) converter = new PcmResampler(data.sampleRate, this.inputSampleRate)
          const converted = converter.push(data.samples, data.channelCount)
          if (converted.length) this.onAudio?.(encodePcm(converted))
        } catch { this.fail('invalid incoming audio') }
      }
    } else if (track.kind === 'video' && this.video && this.videoTracks++ === 0) {
      const sink = new this.rtc.nonstandard.RTCVideoSink(track)
      this.sinks.push(sink)
      sink.onframe = ({ frame }) => {
        if (this.closed || this.imageBusy || Date.now() - this.lastImageAt < 1000) return
        if (frame.width * frame.height > 1920 * 1080) return
        this.lastImageAt = Date.now()
        this.imageBusy = true
        const data = new Uint8ClampedArray(frame.width * frame.height * 4)
        try {
          this.rtc.nonstandard.i420ToRgba(frame, { width: frame.width, height: frame.height, data })
          this.sharp(Buffer.from(data), { raw: { width: frame.width, height: frame.height, channels: 4 } })
            .rotate(frame.rotation || 0)
            .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 65 })
            .toBuffer()
            .then(jpeg => {
              const image = jpeg.toString('base64')
              if (!this.closed && image.length <= 256 * 1024) this.onImage?.(image)
            })
            .catch(() => this.fail('video conversion failed'))
            .finally(() => { this.imageBusy = false })
        } catch { this.imageBusy = false; this.fail('invalid video frame') }
      }
    } else this.fail('unexpected media track')
  }

  begin(responseId) {
    this.known.add(responseId)
    while (this.known.size > 128) this.known.delete(this.known.values().next().value)
  }

  append({ audio, sampleRate, responseId }) {
    if (this.closed || this.blocked.has(responseId)) return
    try {
      this.begin(responseId)
      let response = this.responses.get(responseId)
      if (!response) {
        if (this.responses.size >= 32) throw new Error('too many pending responses')
        response = { converter: new PcmResampler(sampleRate, 48000), started: false, done: false }
        this.responses.set(responseId, response)
      }
      if (response.done || response.converter.from !== sampleRate) throw new Error('invalid response audio sequence')
      this.enqueue(responseId, response.converter.push(decodePcm(audio)))
    } catch { this.fail('invalid or excessive output audio') }
  }

  enqueue(responseId, samples) {
    if (!samples.length) return
    if (this.queuedSamples + samples.length > 48000 * 60) throw new Error('audio consumer is too slow')
    this.queue.push({ responseId, samples, offset: 0 })
    this.queuedSamples += samples.length
  }

  finish(responseId) {
    const response = this.responses.get(responseId)
    if (!response || response.done) return
    response.done = true
    try {
      this.enqueue(responseId, response.converter.finish())
      this.queue.push({ responseId, end: true })
    } catch { this.fail('output queue full') }
  }

  pump() {
    if (!this.connected()) return
    const samples = new Int16Array(480)
    let filled = 0
    let drained
    while (this.queue.length && filled < samples.length) {
      const entry = this.queue[0]
      if (entry.end) {
        this.queue.shift()
        this.responses.delete(entry.responseId)
        drained = entry.responseId
        break
      }
      const response = this.responses.get(entry.responseId)
      if (response && !response.started) {
        response.started = true
        this.send({ type: 'qwaudio.output.started', response_id: entry.responseId })
      }
      const length = Math.min(samples.length - filled, entry.samples.length - entry.offset)
      samples.set(entry.samples.subarray(entry.offset, entry.offset + length), filled)
      filled += length
      entry.offset += length
      this.queuedSamples -= length
      if (entry.offset === entry.samples.length) this.queue.shift()
    }
    try {
      this.source.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 })
      if (drained) this.send({ type: 'qwaudio.output.drained', response_id: drained })
    } catch { this.fail('audio sender failed') }
  }

  clear() {
    for (const responseId of this.known) this.blocked.add(responseId)
    while (this.blocked.size > 128) this.blocked.delete(this.blocked.values().next().value)
    this.known.clear()
    this.responses.clear()
    this.queue = []
    this.queuedSamples = 0
  }

  fail(message) {
    if (this.closed || this.failing) return
    this.failing = true
    this.send({ type: 'error', error: { code: 'media_failed', message } })
    this.onClose?.()
    this.close()
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.tick)
    clearTimeout(this.disconnectedTimer)
    this.clear()
    for (const sink of this.sinks) sink.stop()
    this.track.stop()
    for (const channel of this.channels) channel.close()
    this.pc.close()
  }
}
