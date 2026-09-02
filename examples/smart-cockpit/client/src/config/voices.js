export const COCKPIT_VOICES = Object.freeze([
  Object.freeze({ id: 'longanqian', label: '甜美女声' }),
  Object.freeze({ id: 'longanlufeng', label: '阳光男声' }),
])

export const COCKPIT_VOICE_IDS = Object.freeze(
  COCKPIT_VOICES.map(voice => voice.id),
)

export const DEFAULT_COCKPIT_VOICE = COCKPIT_VOICES[0].id
