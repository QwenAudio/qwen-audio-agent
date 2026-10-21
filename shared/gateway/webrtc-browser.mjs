import { encodeWebRtcMessage } from './webrtc-message.mjs'

// Browser transport only. No tools, prompts or visual-observation policy.
// Shared by the minimal WebRTC page and the X-Omni presentation.
export class BrowserWebRtcConnection {
  constructor({ sessionId, clientActions = [], takeover = false, fetch: request = globalThis.fetch,
    onEvent = () => {}, onState = () => {}, onError = () => {}, onPlayback = () => {}, audio = null,
    mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
    Object.assign(this, { sessionId, clientActions, takeover, request, onEvent, onState, onError, onPlayback, mediaDevices })
    this.audio = audio || document.createElement('audio')
    this.audio.autoplay = true
    this.audio.muted = false
    this.audio.setAttribute('playsinline', '')
    this.outputs = new Map()
    this.abort = new AbortController()
    this.ready = false
    this.closed = false
    this.microphoneEnabled = false
    this.videoGeneration = 0
  }

  async connect() {
    this.onState('connecting')
    try {
      const response = await this.request('/api/v1/webrtc/config', { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]) })
      const config = await response.json()
      if (!response.ok) throw new Error(config.error?.message || 'Cannot read WebRTC configuration')
      if (this.closed) return
      this.config = config
      this.context = new AudioContext()
      this.pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
      this.audioSender = this.pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
      if (config.video_input) this.videoSender = this.pc.addTransceiver('video', { direction: 'sendonly' }).sender
      this.pc.onconnectionstatechange = () => {
        clearTimeout(this.disconnectTimer)
        if (this.pc.connectionState === 'failed') this.fail(new Error('WebRTC media connection failed'))
        if (this.pc.connectionState === 'disconnected') this.disconnectTimer = setTimeout(() => this.fail(new Error('WebRTC media connection lost')), 10000)
      }
      this.pc.ondatachannel = ({ channel }) => {
        if (channel.label !== 'txt' || this.closed) return
        this.channel = channel
        channel.onmessage = ({ data }) => {
          try { this.received(JSON.parse(data)) } catch (error) { this.fail(error) }
        }
        channel.onclose = () => { if (!this.closed) this.fail(new Error('WebRTC control channel closed')) }
      }
      this.pc.createDataChannel('oai-events', { ordered: true })
      this.pc.ontrack = ({ track }) => {
        if (track.kind !== 'audio' || this.closed) return
        const stream = new MediaStream([track])
        this.audio.srcObject = stream
        const source = this.context.createMediaStreamSource(stream)
        this.analyser = this.context.createAnalyser()
        this.analyser.fftSize = 1024
        this.samples = new Float32Array(this.analyser.fftSize)
        source.connect(this.analyser)
        this.audio.play().catch(() => { if (!this.closed) this.onError(new Error('Click the microphone or Send button to enable audio playback.')) })
      }
      this.playbackMeter = setInterval(() => this.measurePlayback(), 50)
      this.connectTimer = setTimeout(() => this.fail(new Error('WebRTC connection timed out')), 25000)
      await this.pc.setLocalDescription(await this.pc.createOffer())
      await this.gatherIce()
      if (this.closed) return
      const query = new URLSearchParams({ sessionId: this.sessionId, model: config.model })
      if (this.clientActions.length) query.set('client_actions', JSON.stringify(this.clientActions))
      if (this.takeover) query.set('takeover', 'true')
      const answer = await this.request(`/api/v1/webrtc/realtime?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' },
        body: this.pc.localDescription.sdp, signal: this.abort.signal,
      })
      if (!answer.ok) throw new Error((await answer.json()).error?.message || `HTTP ${answer.status}`)
      this.location = answer.headers.get('Location')
      if (this.closed) { await this.release(); return }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
    } catch (error) { if (!this.closed) this.fail(error) }
  }

  gatherIce() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        this.pc.removeEventListener('icegatheringstatechange', changed)
        this.abort.signal.removeEventListener('abort', cancelled)
        error ? reject(error) : resolve()
      }
      const changed = () => { if (this.pc.iceGatheringState === 'complete') finish() }
      const cancelled = () => finish(new Error('Connection closed'))
      const timer = setTimeout(() => finish(new Error('ICE gathering timed out')), 12000)
      this.pc.addEventListener('icegatheringstatechange', changed)
      this.abort.signal.addEventListener('abort', cancelled, { once: true })
      changed()
    })
  }

  send(event) {
    if (this.closed || this.channel?.readyState !== 'open') return false
    try {
      const frames = encodeWebRtcMessage({ event_id: crypto.randomUUID(), ...event })
      const bytes = frames.reduce((size, frame) => size + new TextEncoder().encode(frame).length, 0)
      if (this.channel.bufferedAmount + bytes > 1024 * 1024) throw new Error('WebRTC control channel is congested')
      for (const frame of frames) this.channel.send(frame)
      return true
    } catch (error) { this.fail(error); return false }
  }
  command(event) { return this.send({ type: 'qwaudio.command', event: { event_id: crypto.randomUUID(), ...event } }) }
  receipt(type, responseId) { return this.send({ type: `qwaudio.playback.${type}`, response_id: responseId }) }

  received(event) {
    if (this.closed) return
    if (event.type === 'session.updated') {
      clearTimeout(this.connectTimer)
      this.ready = true
      this.updateMicrophone()
      this.onState('connected')
    } else if (event.type === 'qwaudio.output.started') {
      this.outputs.set(event.response_id, { started: false, drained: 0, quiet: 0 })
    } else if (event.type === 'qwaudio.output.drained') {
      const output = this.outputs.get(event.response_id)
      if (output) output.drained = performance.now()
    } else if (event.type === 'output_audio_buffer.cleared') this.clearPlayback()
    else if (event.type === 'qwaudio.event') {
      const item = event.event
      if (['input.suspend', 'input.resume'].includes(item.type)) {
        this.suspended = item.type === 'input.suspend'
        this.updateMicrophone()
      }
      if (item.type === 'voice.connection' && item.state !== 'connected') {
        this.ready = false
        this.updateMicrophone()
        this.onState(item.state === 'connecting' ? 'connecting' : 'disconnected')
      }
    }
    this.onEvent(event)
    if (event.type === 'qwaudio.connection.closed') void this.close()
  }

  async activateAudio() {
    if (this.closed) return
    await this.context?.resume()
    if (this.audio.srcObject) await this.audio.play()
  }
  updateMicrophone() {
    for (const track of this.microphone?.getAudioTracks() || []) track.enabled = this.ready && this.microphoneEnabled && !this.suspended
    if (this.videoSender?.track) this.videoSender.track.enabled = this.ready && !this.suspended
  }
  async setMicrophoneEnabled(enabled) {
    this.microphoneEnabled = enabled
    this.updateMicrophone()
    if (!enabled || this.closed || !this.audioSender) return
    // The same stream is retained while muted; overlapping permission prompts
    // and late getUserMedia results may not resurrect a closed connection.
    if (!this.microphone && !this.microphoneRequest) {
      this.microphoneRequest = this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      }).then(async stream => {
        if (this.closed) { stream.getTracks().forEach(track => track.stop()); return }
        this.microphone = stream
        this.updateMicrophone()
        await this.audioSender.replaceTrack(stream.getAudioTracks()[0])
      }).finally(() => { this.microphoneRequest = null })
    }
    await this.microphoneRequest
  }

  async setVideoTrack(track) {
    if (this.closed || !this.videoSender) return
    if (track) track.enabled = this.ready && !this.suspended
    await this.videoSender.replaceTrack(track)
  }
  sendImageFrame(image) {
    if (!this.ready || this.closed || this.suspended || !this.videoSender || this.framePending) return false
    const generation = this.videoGeneration
    this.framePending = true
    const bitmap = new Image()
    bitmap.onload = async () => {
      try {
        if (this.closed || generation !== this.videoGeneration || this.suspended) return
        if (!this.canvas) {
          this.canvas = document.createElement('canvas')
          Object.assign(this.canvas, { width: 640, height: 480 })
        }
        const context = this.canvas.getContext('2d')
        const scale = Math.min(640 / bitmap.width, 480 / bitmap.height)
        context.clearRect(0, 0, 640, 480)
        context.drawImage(bitmap, (640 - bitmap.width * scale) / 2, (480 - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale)
        if (!this.canvasStream) this.canvasStream = this.canvas.captureStream(0)
        const track = this.canvasStream.getVideoTracks()[0]
        await this.setVideoTrack(track)
        if (!this.closed && generation === this.videoGeneration && !this.suspended) track.requestFrame()
      } catch (error) { if (!this.closed) this.onError(error) }
      finally { this.framePending = false }
    }
    bitmap.onerror = () => { this.framePending = false; if (!this.closed) this.onError(new Error('Invalid visual frame')) }
    bitmap.src = `data:image/jpeg;base64,${image}`
    return true
  }
  clearVideo() {
    this.videoGeneration++
    for (const track of this.canvasStream?.getTracks() || []) track.stop()
    this.canvasStream = null
    if (!this.closed) {
      this.setVideoTrack(null).catch(error => this.onError(error))
      this.command({ type: 'input_image_buffer.clear' })
    }
  }

  measurePlayback() {
    if (!this.analyser || this.audio.paused || this.audio.muted || this.context.state !== 'running') return
    const level = this.outputLevel()
    const first = this.outputs.entries().next().value
    if (!first) return
    const [id, output] = first
    const now = performance.now()
    if (level > 0.002) {
      output.quiet = 0
      if (!output.started) { output.started = true; this.receipt('started', id); this.onPlayback('speaking') }
    } else output.quiet ||= now
    if (output.started && output.drained && now - output.drained > 500 && output.quiet && now - output.quiet > 300) {
      this.receipt('ended', id)
      this.outputs.delete(id)
      if (!this.outputs.size) this.onPlayback('idle')
    }
  }
  outputLevel() {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length)
  }
  clearPlayback() {
    for (const id of this.outputs.keys()) this.receipt('cancelled', id)
    this.outputs.clear()
    this.onPlayback('idle')
    this.audio.muted = true
    clearTimeout(this.unmuteTimer)
    this.unmuteTimer = setTimeout(() => { if (!this.closed) this.audio.muted = false }, 400)
  }
  interrupt() { this.clearPlayback(); return this.send({ type: 'response.cancel' }) }
  fail(error) { this.onError(error); void this.close() }
  async release() {
    const location = this.location
    this.location = null
    if (location) await this.request(location, { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => {})
  }
  close() {
    if (this.closed) return this.closing || Promise.resolve()
    this.closed = true
    this.ready = false
    this.abort.abort()
    clearInterval(this.playbackMeter)
    for (const timer of [this.connectTimer, this.disconnectTimer, this.unmuteTimer]) clearTimeout(timer)
    this.clearVideo()
    for (const track of this.microphone?.getTracks() || []) track.stop()
    this.pc?.close()
    this.audio.pause()
    this.audio.srcObject = null
    this.outputs.clear()
    this.onState('disconnected')
    this.closing = Promise.all([this.context?.close().catch(() => {}), this.release()])
    return this.closing
  }
}
