export const GatewayClientEvent = Object.freeze({
  CONNECT: 'connect',
  UNMUTE: 'unmute',
  MUTE: 'mute',
  INPUT_UNMUTE: 'input.unmute',
  INPUT_MUTE: 'input.mute',
  AUDIO_APPEND: 'audio.append',
  TEXT_MESSAGE: 'text.message',
  INPUT_MESSAGE: 'input.message',
  INPUT_PARTS: 'input.parts',
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
  DICTATION_START: 'dictation.start',
  DICTATION_AUDIO_APPEND: 'dictation.audio.append',
  DICTATION_PAUSE: 'dictation.pause',
  DICTATION_RESUME: 'dictation.resume',
  DICTATION_CANCEL: 'dictation.cancel',
  DICTATION_STOP: 'dictation.stop',
  DICTATION_RESET: 'dictation.reset',
  DICTATION_CONTEXT: 'dictation.context',
  DICTATION_COMMIT_ACK: 'dictation.commit.ack',
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
  DICTATION_STATE: 'dictation.state',
  DICTATION_PARTIAL: 'dictation.partial',
  DICTATION_FINAL: 'dictation.final',
  DICTATION_OPERATION: 'dictation.operation',
  DICTATION_COMMIT_REQUEST: 'dictation.commit.request',
  AUDIO_DELTA: 'audio.delta',
  AUDIO_DONE: 'audio.done',
  RESPONSE_STARTED: 'response.started',
  RESPONSE_INTERRUPTED: 'response.interrupted',
  TRANSCRIPT_DELTA: 'transcript.delta',
  TRANSCRIPT_FINAL: 'transcript.final',
  TRANSCRIPT_DISCARD: 'transcript.discard',
  TIMELINE_INLINE: 'timeline.inline',
  CLIENT_STATE: 'client.state',
  ERROR: 'error',
})

export const GatewayTaskEvent = Object.freeze({
  SCHEDULED: 'task.scheduled',
  SCHEDULED_FIRED: 'task.scheduled.fired',
  RUNNING: 'task.running',
  DELEGATED: 'task.delegated',
  FINALIZING: 'task.finalizing',
  CANCELLING: 'task.cancelling',
  PROGRESS: 'task.progress',
  PROGRESS_CHECK: 'task.progress.check',
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  PERMISSION_REQUESTED: 'task.permission.requested',
  PERMISSION_RESOLVED: 'task.permission.resolved',
  NOTIFICATION_OFFLINE: 'task.notification.offline',
})

export const GATEWAY_CLIENT_EVENT_TYPES = new Set(
  Object.values(GatewayClientEvent),
)

export const GATEWAY_SERVER_EVENT_TYPES = new Set([
  ...Object.values(GatewayServerEvent),
  ...Object.values(GatewayTaskEvent),
])
