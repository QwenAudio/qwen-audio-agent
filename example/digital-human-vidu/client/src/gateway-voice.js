import { GatewayClient } from '../../../../shared/gateway/client-sdk.mjs'
import { GatewayClientCapability } from '../../../../shared/protocol/gateway-client-protocol.mjs'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../../../shared/protocol/realtime-events.mjs'
import {
  createPcmPlaybackQueue,
  createRealtimeAudioSendController,
  createStreamingResampler,
  decodePcm,
  pcmBase64,
} from '../../../../web/src/realtime/audio.js'
import { createMicrophoneAudioWorkletNode } from '../../../../web/src/realtime/microphone-audio-worklet.js'
import {
  createGatewayWebSocket,
  gatewayRealtimeUrl,
} from '../../../../web/src/gateway-transport.js'

const DEFAULT_INPUT_RATE = 16_000
const DEFAULT_OUTPUT_RATE = 24_000
const workletUrl = new URL(
  '../../../../web/src/realtime/microphone-audio-worklet-processor.js?no-inline',
  import.meta.url,
).href

export function gatewayModelFromHealth(health = {}) {
  return String(health.realtimeModel || health.realtimeModelProfile?.id || '')
}

export class GatewayVoiceConnection {
  constructor({
    sessionId = 'digital-human-vidu',
    onEvent = () => {},
    onState = () => {},
    onError = () => {},
    onPlayback = () => {},
    tools = [],
    onAction,
    mediaDevices = globalThis.navigator?.mediaDevices,
  } = {}) {
    Object.assign(this, {
      sessionId,
      onEvent,
      onState,
      onError,
      onPlayback,
      tools,
      onAction,
      mediaDevices,
    })
    this.clientInstanceId = crypto.randomUUID()
    this.inputSampleRate = DEFAULT_INPUT_RATE
    this.microphoneEnabled = true
    this.ready = false
    this.closed = false
    this.sources = new Set()
    this.responses = new Map()
    this.cursor = 0
    this.queue = createPcmPlaybackQueue({
      onFlush: items => items.forEach(item => this.schedule(item)),
    })
  }

  async connect() {
    if (this.client || this.closed) return
    this.onState('connecting')
    try {
      await this.activateAudio()
      await this.openMicrophone()
      if (this.closed) return
      this.client = new GatewayClient({
        url: gatewayRealtimeUrl(this.sessionId),
        createSocket: createGatewayWebSocket,
        clientType: 'web',
        clientLabel: 'digital-human-vidu',
        clientInstanceId: this.clientInstanceId,
        takeover: true,
        capabilities: [GatewayClientCapability.INPUT_AUDIO, GatewayClientCapability.INPUT_TEXT,
          GatewayClientCapability.PLAYBACK_RECEIPTS, GatewayClientCapability.SESSION_HEARTBEAT],
        reconnect: false,
        tools: this.tools,
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        configure: () => ({
          voiceEnabled: true,
          inputEnabled: this.microphoneEnabled,
          outputEnabled: true,
          textOnly: false,
          clientType: 'web',
          clientLabel: 'digital-human-vidu',
          clientInstanceId: this.clientInstanceId,
        }),
        onEvent: event => this.receive(event),
        onAction: event => this.onAction?.(event),
        onRecovery: recovery => this.onEvent({ type: 'session.recovered', ...recovery }),
        onStatus: status => this.status(status),
      })
      this.client.start()
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  async activateAudio() {
    if (!this.context || this.context.state === 'closed') {
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!AudioContext) throw new Error('当前环境不支持实时语音播放')
      this.context = new AudioContext()
      // A silent PCM clock supplies approximate Gateway playback receipts.
      // Audible media comes exclusively from ARTC, which has no response IDs.
      this.silentOutput = this.context.createGain()
      this.silentOutput.gain.value = 0
      this.silentOutput.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
  }

  async openMicrophone() {
    if (this.microphone) return
    if (!this.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风输入')
    const media = await this.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (this.closed) {
      media.getTracks().forEach(track => track.stop())
      return
    }
    const resampler = createStreamingResampler()
    const source = this.context.createMediaStreamSource(media)
    const sender = createRealtimeAudioSendController({
      send: event => this.client?.send(event) === true,
      getBufferedAmount: () => this.client?.bufferedAmount || 0,
    })
    let processor
    try {
      processor = await createMicrophoneAudioWorkletNode({
        context: this.context,
        moduleUrl: workletUrl,
        onSamples: samples => {
          if (!this.ready || !this.microphoneEnabled || this.inputSuspended || this.closed) return
          const audio = resampler.process(samples, this.context.sampleRate, this.inputSampleRate)
          if (audio.length) sender.send({ type: GatewayClientEvent.AUDIO_APPEND, audio: pcmBase64(audio) })
        },
      })
    } catch (error) {
      source.disconnect()
      media.getTracks().forEach(track => track.stop())
      throw error
    }
    if (this.closed) {
      processor.close()
      source.disconnect()
      media.getTracks().forEach(track => track.stop())
      return
    }
    source.connect(processor.node)
    processor.node.connect(this.context.destination)
    this.microphone = { media, source, processor, resampler, sender }
  }

  status(status) {
    if (this.closed) return
    if (status.state === 'connected') this.onState('connecting')
    if (status.state === 'ready') return
    if (status.state === 'occupied') return this.fail(new Error('Gateway 正由另一个客户端使用'))
    if (status.state === 'replaced') return this.fail(new Error('语音连接已切换到另一个界面'))
    if (status.state === 'revoked') return this.fail(new Error('Gateway 访问权限已被撤销'))
    if (status.state === 'unavailable') {
      this.ready = false
      this.stopPlayback('connection_lost')
      this.onState('connecting')
    }
    if (status.state === 'disconnected') {
      this.ready = false
      this.stopPlayback('connection_lost')
      this.onState('disconnected')
    }
  }

  receive(event) {
    if (this.closed) return
    if (event.type === GatewayServerEvent.VOICE_READY) {
      this.inputSampleRate = event.inputSampleRate || DEFAULT_INPUT_RATE
      this.ready = true
      this.onState('connected')
    } else if (event.type === GatewayServerEvent.VOICE_CONNECTION) {
      this.ready = event.state === 'connected'
      this.onState(this.ready ? 'connected' : event.state)
    } else if (event.type === GatewayServerEvent.VOICE_STATE) {
      if (event.state === 'listening' && this.sources.size) {
        this.stopPlayback('user_interruption')
      }
      this.onState(event.state)
    } else if (event.type === GatewayServerEvent.RESPONSE_STARTED) {
      this.onState('processing')
    } else if (event.type === GatewayServerEvent.AUDIO_DELTA) {
      this.play(event.audio, event.sampleRate, event.responseId)
    } else if (event.type === GatewayServerEvent.AUDIO_DONE) {
      this.audioDone(event.responseId)
    } else if (
      event.type === GatewayServerEvent.PLAYBACK_CLEAR
      || event.type === GatewayServerEvent.RESPONSE_INTERRUPTED
    ) {
      this.stopPlayback(event.reason || 'user_interruption')
    } else if (event.type === GatewayServerEvent.INPUT_SUSPEND) {
      this.inputSuspended = true
      this.client?.send({ type: GatewayClientEvent.INPUT_SUSPEND_ACK })
    } else if (event.type === GatewayServerEvent.INPUT_RESUME) {
      this.inputSuspended = false
    } else if (event.type === GatewayServerEvent.ERROR) {
      this.onError(new Error(event.message || '语音连接发生错误'))
    }
    this.onEvent(event)
  }

  play(base64, sampleRate = DEFAULT_OUTPUT_RATE, responseId = '') {
    try {
      const samples = decodePcm(base64)
      this.queue.push({
        samples,
        sampleRate,
        responseId,
        duration: samples.length / sampleRate,
      }, {
        timelineAheadSeconds: Math.max(0, this.cursor - this.context.currentTime),
      })
    } catch (error) {
      this.fail(error)
    }
  }

  response(responseId) {
    let response = this.responses.get(responseId)
    if (!response) {
      response = { sources: 0, done: false, started: false }
      this.responses.set(responseId, response)
    }
    return response
  }

  schedule({ samples, sampleRate, responseId }) {
    if (this.closed || !this.context) return
    const buffer = this.context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.silentOutput)
    const start = Math.max(this.context.currentTime + 0.02, this.cursor)
    this.cursor = start + buffer.duration
    this.sources.add(source)
    const response = this.response(responseId)
    response.sources += 1
    if (!response.started) {
      response.started = true
      const delay = Math.max(0, (start - this.context.currentTime) * 1000)
      response.timer = setTimeout(() => {
        if (this.closed || !this.responses.has(responseId)) return
        this.client?.send({ type: GatewayClientEvent.PLAYBACK_STARTED, responseId })
        this.onPlayback('speaking')
      }, delay)
    }
    source.onended = () => {
      this.sources.delete(source)
      const current = this.responses.get(responseId)
      if (!current) return
      current.sources = Math.max(0, current.sources - 1)
      this.finishResponse(responseId)
    }
    source.start(start)
  }

  audioDone(responseId) {
    this.queue.finish()
    this.response(responseId).done = true
    this.finishResponse(responseId)
  }

  finishResponse(responseId) {
    const response = this.responses.get(responseId)
    if (!response?.done || response.sources > 0) return
    clearTimeout(response.timer)
    this.responses.delete(responseId)
    this.client?.send({ type: GatewayClientEvent.PLAYBACK_ENDED, responseId })
    this.onPlayback('listening')
  }

  stopPlayback(reason = 'user_interruption') {
    this.queue.reset()
    for (const source of this.sources) {
      try { source.stop() } catch {}
    }
    this.sources.clear()
    for (const [responseId, response] of this.responses) {
      clearTimeout(response.timer)
      this.client?.send({ type: GatewayClientEvent.PLAYBACK_CANCELLED, responseId, reason })
    }
    this.responses.clear()
    this.cursor = this.context?.currentTime || 0
    this.onPlayback('listening')
  }

  sendText(text) {
    if (!this.client?.ready || !text) return false
    return this.client.send({
      type: GatewayClientEvent.INPUT_MESSAGE,
      parts: [{ type: 'text', text }],
    })
  }

  interrupt() {
    this.stopPlayback('user_interruption')
    return this.client?.send({ type: GatewayClientEvent.INTERRUPT }) === true
  }

  async setMicrophoneEnabled(enabled) {
    if (this.closed) return
    this.microphoneEnabled = enabled === true
    if (this.microphoneEnabled && !this.microphone) await this.openMicrophone()
    for (const track of this.microphone?.media.getAudioTracks() || []) {
      track.enabled = this.microphoneEnabled
    }
    this.client?.send({
      type: this.microphoneEnabled
        ? GatewayClientEvent.INPUT_UNMUTE
        : GatewayClientEvent.INPUT_MUTE,
    })
  }

  fail(error) {
    if (this.closed) return
    this.ready = false
    this.onError(error)
    this.onState('error')
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.ready = false
    this.stopPlayback('connection_closed')
    this.client?.stop()
    this.client = null
    this.microphone?.media.getTracks().forEach(track => track.stop())
    this.microphone?.processor.close()
    this.microphone?.source.disconnect()
    this.microphone?.resampler.reset()
    this.microphone?.sender.reset()
    this.microphone = null
    await this.context?.close()
    this.context = null
    this.silentOutput = null
  }
}
