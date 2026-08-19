export const DICTATION_DEFAULT_TIMEOUT_MS = 45_000

export const DICTATION_CAPABILITIES = Object.freeze([
  'dictation.session-v1',
  'dictation.draft-ops-v1',
  'dictation.commit-idempotency-v1',
])

export const DictationClientEvent = Object.freeze({
  START: 'dictation.start',
  AUDIO_APPEND: 'dictation.audio.append',
  PAUSE: 'dictation.pause',
  RESUME: 'dictation.resume',
  CANCEL: 'dictation.cancel',
  STOP: 'dictation.stop',
  CONTEXT: 'dictation.context',
  OPERATION_ACK: 'dictation.operation.ack',
  COMMIT_ACK: 'dictation.commit.ack',
})

export const DictationServerEvent = Object.freeze({
  STATE: 'dictation.state',
  TRANSCRIPT_DELTA: 'dictation.transcript.delta',
  TRANSCRIPT_FINAL: 'dictation.transcript.final',
  CONTEXT_REQUEST: 'dictation.context.request',
  OPERATION: 'dictation.operation',
  COMMIT_REQUEST: 'dictation.commit.request',
  ERROR: 'dictation.error',
})

export const DICTATION_STATES = Object.freeze([
  'starting',
  'listening',
  'transcribing',
  'editing',
  'ready-to-send',
  'paused',
  'cancelled',
  'error',
])

const CLIENT_TYPES = new Set(Object.values(DictationClientEvent))
const SERVER_TYPES = new Set(Object.values(DictationServerEvent))

export function isDictationClientEvent(event) {
  return CLIENT_TYPES.has(event?.type)
}
export function isDictationServerEvent(event) {
  return SERVER_TYPES.has(event?.type)
}
