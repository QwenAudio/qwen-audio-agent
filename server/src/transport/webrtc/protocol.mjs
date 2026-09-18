import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  createGatewaySessionHello,
  GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  GatewayClientCapability,
  isGatewayClientRuntimeMessage,
} from '../../../../shared/protocol/gateway-client-protocol.mjs'

const id = () => `evt_rtc_${randomUUID()}`

// The runtime sees the same connection contract as WebSocket. Neither the
// media engine nor vendor-shaped wire events own sessions, tools or history.
export class WebRtcConnection extends EventEmitter {
  constructor({ media, sessionId, provider, takeover = false }) {
    super()
    this.media = media
    this.sessionId = sessionId
    this.provider = provider
    this.takeover = takeover
    this.readyState = 1
    this.voice = provider.voice?.() || ''
    this.ready = false
    this.pendingItem = null
    this.update = null
    this.video = provider.modelProfile?.()?.transportCapabilities?.imageBufferInput === true
    this.inputAllowed = true
  }

  start() {
    this.input(createGatewaySessionHello({
      clientType: 'web',
      clientInstanceId: randomUUID(),
      clientLabel: 'WebRTC',
      capabilities: GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.filter(capability => (
        ![GatewayClientCapability.SESSION_HEARTBEAT, GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP].includes(capability)
        && (this.video || capability !== GatewayClientCapability.INPUT_IMAGE_BUFFER)
      )),
      connection: { provider: this.provider.key, voice_enabled: true, input_enabled: true, output_enabled: true },
      takeover: this.takeover,
    }))
  }

  description() {
    return {
      id: this.sessionId,
      object: 'realtime.session',
      model: this.provider.model(),
      modalities: ['text', 'audio'],
      voice: this.voice,
      turn_detection: this.provider.modelProfile?.()?.sessionDefaults?.turnDetection || null,
      qwaudio: { transport: 'webrtc', video_input: this.video, protocol: '0.1', experimental: true },
    }
  }

  output(event) {
    if (this.readyState === 1) this.media.send({ event_id: id(), ...event })
  }

  input(event) {
    if (this.readyState === 1) this.emit('message', JSON.stringify({ event_id: id(), ...event }))
  }

  error(code, message, eventId) {
    this.output({ type: 'error', error: { type: 'invalid_request_error', code, message, ...(eventId ? { event_id: eventId } : {}) } })
  }

  receive(raw) {
    let event
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('event must be JSON text, max 64 KiB')
      event = JSON.parse(raw)
      if (!event || typeof event.type !== 'string') throw new Error('event type required')
      if (event.type === 'session.update') {
        const session = event.session
        if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('session object required')
        if (this.update) throw new Error('wait for the pending session.updated')
        const supported = ['voice', 'modalities', 'turn_detection']
        if (Object.keys(session).some(key => !supported.includes(key))) throw new Error('supported session fields: voice, modalities, turn_detection; instructions and tools belong to the Gateway')
        if (session.modalities && JSON.stringify(session.modalities) !== JSON.stringify(['text', 'audio'])) throw new Error('this transport requires modalities [text, audio]')
        if ('turn_detection' in session) {
          const expected = this.description().turn_detection
          if (!session.turn_detection || !expected || Object.entries(session.turn_detection).some(([key, value]) => expected[key] !== value)) throw new Error('turn_detection must match the Gateway configuration; manual audio commit is unsupported')
        }
        if ('voice' in session && (typeof session.voice !== 'string' || !session.voice.trim() || session.voice.length > 160)) throw new Error('invalid voice')
        const voice = session.voice?.trim() || this.voice
        this.provider.validateSessionOptions?.({ sessionOptions: { voice } })
        this.update = { eventId: event.event_id, requestId: id(), voice }
        if (voice !== this.voice) this.input({ type: 'session.output_voice.update', event_id: this.update.requestId, voice })
        else if (this.ready) this.updated()
        return
      }
      if (event.type === 'conversation.item.create') {
        const item = event.item
        if (this.pendingItem) throw new Error('call response.create before adding another item')
        if (item?.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content) || !item.content.length
          || item.content.some(part => part.type !== 'input_text' || typeof part.text !== 'string')) throw new Error('only user messages with input_text content are supported; media uses tracks')
        const text = item.content.map(part => part.text).join('\n')
        if (!text.trim() || text.length > 16000) throw new Error('text must contain 1-16000 characters')
        this.pendingItem = { id: id(), type: 'message', role: 'user', content: item.content }
        this.output({ type: 'conversation.item.created', item: this.pendingItem, qwaudio: { staged: true } })
        return
      }
      if (event.type === 'response.create') {
        if (event.response && Object.keys(event.response).length) throw new Error('per-response overrides are unsupported')
        if (!this.pendingItem) throw new Error('response.create requires a staged text item; audio uses server VAD')
        const text = this.pendingItem.content.map(part => part.text).join('\n')
        this.pendingItem = null
        this.input({ type: 'conversation.item.create', text })
        return
      }
      if (event.type === 'response.cancel') {
        if (event.response_id) throw new Error('omit response_id; targeted cancellation is unsupported')
        this.media.clear()
        this.input({ type: 'response.cancel' })
        this.output({ type: 'output_audio_buffer.cleared' })
        return
      }
      if (['qwaudio.playback.started', 'qwaudio.playback.ended', 'qwaudio.playback.cancelled'].includes(event.type)) {
        if (typeof event.response_id !== 'string' || !event.response_id || event.response_id.length > 128) throw new Error('response_id required')
        this.input({ type: event.type.slice(8), responseId: event.response_id, reason: 'user_interruption' })
        return
      }
      if (event.type === 'qwaudio.command' && isGatewayClientRuntimeMessage(event.event?.type)) {
        this.input({ ...event.event, event_id: event.event.event_id || id() })
        return
      }
      this.error('unsupported_event', `unsupported WebRTC event: ${event.type}`, event.event_id)
    } catch (error) {
      this.error('invalid_event', error.message, event?.event_id)
    }
  }

  updated() {
    const requestEventId = this.update?.eventId
    this.update = null
    this.output({ type: 'session.updated', session: this.description(), ...(requestEventId ? { request_event_id: requestEventId } : {}) })
  }

  audio(audio) {
    if (this.ready && this.inputAllowed) this.input({ type: 'input_audio_buffer.append', audio })
  }

  image(image) {
    if (this.ready && this.inputAllowed && this.video) this.input({ type: 'input_image_buffer.append', image, media_type: 'image/jpeg', occurred_at: Date.now() })
  }

  send(raw) {
    const event = JSON.parse(raw)
    if (event.type === 'session.ready') {
      this.output({ type: 'session.created', session: this.description() })
    } else if (event.type === 'voice.ready') {
      this.ready = true
      this.media.inputSampleRate = event.inputSampleRate
      this.updated()
    } else if (event.type === 'voice.connection') {
      if (['connecting', 'disconnected', 'unavailable'].includes(event.state)) this.ready = false
      this.output({ type: 'qwaudio.event', event })
    } else if (event.type === 'session.output_voice.updated') {
      this.voice = event.voice
      if (!event.reconnecting) this.updated()
    } else if (event.type === 'audio.delta') {
      this.media.append(event)
    } else if (event.type === 'audio.done') {
      this.media.finish(event.responseId)
      this.output({ type: 'response.audio.done', response_id: event.responseId })
    } else if (event.type === 'response.started') {
      this.media.begin?.(event.responseId)
      this.output({ type: 'response.created', response: { id: event.responseId, status: 'in_progress' } })
    } else if (['playback.clear', 'response.interrupted'].includes(event.type)) {
      this.media.clear()
      this.output({ type: 'output_audio_buffer.cleared', response_id: event.responseId, reason: event.reason })
    } else if (['transcript.delta', 'transcript.final'].includes(event.type)) {
      const final = event.type === 'transcript.final'
      this.output({
        type: event.role === 'user'
          ? `conversation.item.input_audio_transcription.${final ? 'completed' : 'delta'}`
          : `response.audio_transcript.${final ? 'done' : 'delta'}`,
        response_id: event.responseId,
        item_id: event.itemId || event.turnId,
        [final ? 'transcript' : 'delta']: event.content,
      })
    } else if (event.type === 'error') {
      if (event.request_event_id === this.update?.requestId) this.update = null
      this.output({ type: 'error', error: event.error || { type: 'server_error', code: 'gateway_error', message: event.message } })
    } else {
      if (event.type === 'input.suspend') this.inputAllowed = false
      if (event.type === 'input.resume') this.inputAllowed = true
      this.output({ type: 'qwaudio.event', event })
    }
  }

  onResponseDone(response) {
    this.output({ type: 'response.done', response })
  }

  ping() { if (this.media.connected()) this.emit('pong') }
  terminate() { this.close(1006, 'transport lost') }

  close(code = 1000, reason = 'closed') {
    if (this.readyState !== 1 || this.closing) return
    // Sending the final event can synchronously report a media failure and
    // re-enter close(). Fence it before any callback, not after notification.
    this.closing = true
    try {
      this.output({ type: 'qwaudio.connection.closed', code, reason })
    } catch {
      // Closing notifications are best effort; cleanup must still run.
    }
    this.readyState = 3
    try {
      this.media.close()
    } finally {
      this.emit('close', code, reason)
    }
  }
}
