export const GatewayClientEvent = Object.freeze({
  CONNECT: 'connect',
  UNMUTE: 'unmute',
  MUTE: 'mute',
  INPUT_UNMUTE: 'input.unmute',
  INPUT_MUTE: 'input.mute',
  AUDIO_APPEND: 'audio.append',
  TEXT_MESSAGE: 'text.message',
  INTERRUPT: 'interrupt',
  PLAYBACK_STARTED: 'playback.started',
  PLAYBACK_ENDED: 'playback.ended',
  PLAYBACK_CANCELLED: 'playback.cancelled',
})

export const GatewayServerEvent = Object.freeze({
  GATEWAY_CONNECTED: 'gateway.connected',
  GATEWAY_DISCONNECTED: 'gateway.disconnected',
  VOICE_CONNECTION: 'voice.connection',
  VOICE_READY: 'voice.ready',
  VOICE_STATE: 'voice.state',
  VOICE_OWNERSHIP: 'voice.ownership',
  VOICE_DEACTIVATED: 'voice.deactivated',
  TURN_STARTED: 'turn.started',
  PLAYBACK_CLEAR: 'playback.clear',
  AUDIO_DELTA: 'audio.delta',
  AUDIO_DONE: 'audio.done',
  RESPONSE_STARTED: 'response.started',
  RESPONSE_INTERRUPTED: 'response.interrupted',
  TRANSCRIPT_DELTA: 'transcript.delta',
  TRANSCRIPT_FINAL: 'transcript.final',
  TRANSCRIPT_DISCARD: 'transcript.discard',
  TIMELINE_INLINE: 'timeline.inline',
  ERROR: 'error',
})

export const GatewayTaskEvent = Object.freeze({
  RUNNING: 'task.running',
  DELEGATED: 'task.delegated',
  FINALIZING: 'task.finalizing',
  CANCELLING: 'task.cancelling',
  PROGRESS: 'task.progress',
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  PERMISSION_REQUESTED: 'task.permission.requested',
  PERMISSION_RESOLVED: 'task.permission.resolved',
})

export const GATEWAY_CLIENT_EVENT_TYPES = new Set(
  Object.values(GatewayClientEvent),
)

export const GATEWAY_SERVER_EVENT_TYPES = new Set([
  ...Object.values(GatewayServerEvent),
  ...Object.values(GatewayTaskEvent),
])
