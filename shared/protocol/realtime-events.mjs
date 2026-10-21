export const GatewayClientEvent = Object.freeze({
  CONNECT: 'connect',
  UNMUTE: 'unmute',
  MUTE: 'mute',
  INPUT_UNMUTE: 'input.unmute',
  INPUT_MUTE: 'input.mute',
  AUDIO_APPEND: 'audio.append',
  IMAGE_APPEND: 'image.append',
  IMAGE_CLEAR: 'image.clear',
  TEXT_MESSAGE: 'text.message',
  INPUT_MESSAGE: 'input.message',
  INTERRUPT: 'interrupt',
  SLEEP: 'sleep',
  WAKE: 'wake',
  PLAYBACK_STARTED: 'playback.started',
  PLAYBACK_ENDED: 'playback.ended',
  PLAYBACK_CANCELLED: 'playback.cancelled',
  // Confirms that a host-requested suspension took effect on this client. A
  // host must not wait for it: pressing a key to record is latency sensitive,
  // so the acknowledgement only feeds status display and timeout healing.
  INPUT_SUSPEND_ACK: 'input.suspend.ack',
  // Transport-reported avatar media playback feedback (first frame pumped,
  // drained, media end, or a media error). This is the input-side counterpart
  // of the DIGITAL_HUMAN_MEDIA_OPEN/CONTROL server events and is only emitted
  // by transports that run an avatar media worker; it never carries bytes.
  DIGITAL_HUMAN_MEDIA: 'digital_human.media',
})

export const GatewayServerEvent = Object.freeze({
  GATEWAY_CONNECTED: 'gateway.connected',
  GATEWAY_DISCONNECTED: 'gateway.disconnected',
  VOICE_CONNECTION: 'voice.connection',
  VOICE_READY: 'voice.ready',
  VOICE_STATE: 'voice.state',
  VOICE_OWNERSHIP: 'voice.ownership',
  VOICE_DEACTIVATED: 'voice.deactivated',
  VOICE_SLEEP: 'voice.sleep',
  TURN_STARTED: 'turn.started',
  PLAYBACK_CLEAR: 'playback.clear',
  // Commands a client to stop and resume audio capture outright, so an
  // external controller can take the microphone. This is the input-side
  // counterpart of PLAYBACK_CLEAR and is stronger than the client-declared
  // INPUT_MUTE: no capture, no wake word detection.
  INPUT_SUSPEND: 'input.suspend',
  INPUT_RESUME: 'input.resume',
  AUDIO_DELTA: 'audio.delta',
  AUDIO_DONE: 'audio.done',
  RESPONSE_STARTED: 'response.started',
  RESPONSE_INTERRUPTED: 'response.interrupted',
  TRANSCRIPT_DELTA: 'transcript.delta',
  TRANSCRIPT_FINAL: 'transcript.final',
  TRANSCRIPT_DISCARD: 'transcript.discard',
  TOOL_CALL: 'tool.call',
  // Owner-scoped invalidation only; clients reload GET /api/memory.
  MEMORY_CHANGED: 'memory.changed',
  AGENT_ACTIVITY: 'agent.activity',
  CLIENT_STATE: 'client.state',
  // Public per-connection digital-human presentation state. Clients render it
  // as an avatar status light; on the WebRTC transport it travels inside a
  // qwaudio.event envelope rather than as a bare frame.
  DIGITAL_HUMAN_STATE: 'digital_human.state',
  // Internal control-plane signals between the session runtime and a media
  // transport. The WebRTC transport intercepts them to drive its media worker
  // and never forwards them to a client; no other transport emits them.
  DIGITAL_HUMAN_MEDIA_OPEN: 'digital_human.media_open',
  DIGITAL_HUMAN_MEDIA_CONTROL: 'digital_human.media_control',
  ERROR: 'error',
})

export const GatewayTaskEvent = Object.freeze({
  SNAPSHOT: 'task.snapshot',
  ACCEPTED: 'task.accepted',
  SCHEDULED: 'task.scheduled',
  SCHEDULED_FIRED: 'task.scheduled.fired',
  RUNNING: 'task.running',
  DELEGATED: 'task.delegated',
  FINALIZING: 'task.finalizing',
  CANCELLING: 'task.cancelling',
  UPDATED: 'task.updated',
  PROGRESS: 'task.progress',
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  PERMISSION_REQUESTED: 'task.permission.requested',
  PERMISSION_RESOLVED: 'task.permission.resolved',
  INPUT_REQUESTED: 'task.input.requested',
  INPUT_RESOLVED: 'task.input.resolved',
  NOTIFICATION_PENDING: 'task.notification.pending',
  NOTIFICATION_DELIVERED: 'task.notification.delivered',
  NOTIFICATION_OFFLINE: 'task.notification.offline',
})

export const GATEWAY_CLIENT_EVENT_TYPES = new Set(
  Object.values(GatewayClientEvent),
)

export const GATEWAY_SERVER_EVENT_TYPES = new Set([
  ...Object.values(GatewayServerEvent),
  ...Object.values(GatewayTaskEvent),
])

export function isGatewayClientEvent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && GATEWAY_CLIENT_EVENT_TYPES.has(value.type),
  )
}

export function isGatewayServerEvent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && GATEWAY_SERVER_EVENT_TYPES.has(value.type),
  )
}
