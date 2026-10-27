// Maps the bounded avatar voice transport onto the product's existing visual
// status vocabulary, so the header status light and the hero reuse the same
// dot colours and labels as the WebSocket app instead of a bespoke set.
const AVATAR_KEYS = new Set([
  'idle', 'listening', 'rendering', 'speaking', 'audio_only', 'error',
])

// avatarState.state -> product status key (see labelFor / .status i.* in App).
const RENDER_MAP = {
  idle: 'idle',
  listening: 'listening',
  rendering: 'processing',
  speaking: 'speaking',
  error: 'error',
  audio_only: 'audio_only',
}

export function avatarVisualState(avatar) {
  if (avatar?.avatarState?.output === 'audio_only') return 'audio_only'
  const state = avatar?.avatarState?.state
  if (state && AVATAR_KEYS.has(state)) return RENDER_MAP[state]
  const connection = avatar?.state
  if (connection === 'connected') {
    if (avatar?.playback === 'speaking') return 'speaking'
    // The session stays connected while the mic is muted, so a muted avatar is
    // 待命 (idle), not 正在听 (listening) — it is not capturing speech.
    return avatar?.micEnabled ? 'listening' : 'idle'
  }
  if (connection === 'connecting') return 'connecting'
  if (connection === 'error') return 'error'
  return 'idle'
}

// The header dot has no dedicated colour for the degraded audio-only state, so
// it borrows the amber "processing" colour while keeping its own label.
export function avatarStatusDot(visual) {
  return visual === 'audio_only' ? 'processing' : visual
}
