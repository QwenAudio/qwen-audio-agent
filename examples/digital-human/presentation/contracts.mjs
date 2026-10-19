// Frozen digital-human vocabulary shared by the orchestrator, the output
// selector, the transport and the example adapters. Values here are contract:
// clients and tests match on these strings, so changes require a protocol
// version bump, not a rename in one layer.

export const SelectorState = Object.freeze({
  BUFFERING: 'buffering',
  COMMITTED_AVATAR: 'committed_avatar',
  COMMITTED_AUDIO: 'committed_audio',
  DRAINING: 'draining',
  TERMINAL: 'terminal',
  CANCELLED: 'cancelled',
})

export const AudioRoute = Object.freeze({
  DIVERT: 'divert',
  PASS: 'pass',
})

// Provider-facing error taxonomy (provider-contract.zh.md §4). Vendor-native
// errors stay in redacted diagnostics and never surface as these codes.
export const DIGITAL_HUMAN_ERROR_CODES = Object.freeze([
  'unavailable',
  'capacity_exhausted',
  'invalid_media',
  'first_media_timeout',
  'media_stalled',
  'protocol_error',
])

// Why a turn was cancelled. user_interruption and provider_failure must stay
// distinguishable: the former may confirm a task notification the user chose
// to skip, the latter never does.
export const DIGITAL_HUMAN_CANCEL_REASONS = Object.freeze([
  'user_interruption',
  'content_safety',
  'permission_revoked',
  'owner_replaced',
  'provider_failure',
  'transport_lost',
  'session_closed',
])

// Public per-connection presentation state, carried inside qwaudio.event as
// internal event `digital_human.state`.
export const DigitalHumanState = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  RENDERING: 'rendering',
  SPEAKING: 'speaking',
  AUDIO_ONLY: 'audio_only',
  ERROR: 'error',
})

export const DIGITAL_HUMAN_STATE_EVENT = 'digital_human.state'

/**
 * @typedef {Object} TurnRef
 * @property {string} avatarSessionId  ephemeral provider session, recreated on reconnect
 * @property {string} responseId       gateway response id; no second conversation id
 * @property {number} generation       presentation generation; cancels invalidate older output
 */

/**
 * @typedef {Object} AudioFormat
 * @property {'pcm_s16le'} encoding
 * @property {number} sampleRate
 * @property {1} channels
 */

/**
 * @typedef {Object} DigitalHumanStatePayload
 * @property {string} state       one of DigitalHumanState
 * @property {string} [responseId]
 * @property {string} [reason]     cancel/fallback reason, free text
 * @property {string} [code]       one of DIGITAL_HUMAN_ERROR_CODES when error-driven
 */

export function createStatePayload({ state, responseId = null, reason = null, code = null }) {
  if (!Object.values(DigitalHumanState).includes(state)) {
    throw new Error(`unknown digital human state ${state}`)
  }
  if (code !== null && !DIGITAL_HUMAN_ERROR_CODES.includes(code)) {
    throw new Error(`unknown digital human error code ${code}`)
  }
  return { state, responseId, reason, code }
}

export function assertCancelReason(reason) {
  if (!DIGITAL_HUMAN_CANCEL_REASONS.includes(reason)) {
    throw new Error(`unknown cancel reason ${reason}`)
  }
  return reason
}
