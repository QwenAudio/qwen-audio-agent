// Client-owned presentation catalog. The Gateway owns the trusted Markdown
// behind each id; this module owns only what the cockpit UI displays.
export const COCKPIT_ASSISTANT_PROFILE_EVENT = 'cockpit.assistant_profile.selected'
export const COCKPIT_PERSONAS = Object.freeze([
  Object.freeze({
    id: 'healer',
    label: '聊愈师',
    description: '温柔陪伴，用声音治愈旅途疲惫',
    image: new URL('../assets/personas/healer-character.png', import.meta.url).href,
  }),
  Object.freeze({
    id: 'action',
    label: '行动派',
    description: '直击要点，高效执行每一个指令',
    image: new URL('../assets/personas/action-character.png', import.meta.url).href,
  }),
  Object.freeze({
    id: 'sharp',
    label: '疯批',
    description: '有逻辑地反驳，毒舌但不越界',
    image: new URL('../assets/personas/wild-character.png', import.meta.url).href,
  }),
])

export const COCKPIT_PERSONA_IDS = Object.freeze(
  COCKPIT_PERSONAS.map(persona => persona.id),
)
export const COCKPIT_PERSONA_LABELS = Object.freeze(
  COCKPIT_PERSONAS.map(persona => persona.label),
)
export const DEFAULT_COCKPIT_PERSONA_ID = COCKPIT_PERSONAS[0].id
export const DEFAULT_COCKPIT_PERSONA_LABEL = COCKPIT_PERSONAS[0].label

export function cockpitPersonaId(label) {
  return COCKPIT_PERSONAS.find(persona => persona.label === label)?.id
    || DEFAULT_COCKPIT_PERSONA_ID
}
