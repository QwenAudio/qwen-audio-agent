import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const COCKPIT_ASSISTANT_PROFILE_EVENT = 'cockpit.assistant_profile.selected'
export const COCKPIT_ASSISTANT_PROFILE_IDS = Object.freeze([
  'healer',
  'action',
  'sharp',
])

export function loadCockpitAssistantProfile(name) {
  if (!COCKPIT_ASSISTANT_PROFILE_IDS.includes(name)) {
    throw new TypeError(`Unknown cockpit Assistant Profile: ${name}`)
  }
  return readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8').trim()
}

export const cockpitAssistantProfileEventDefinition = Object.freeze({
  name: COCKPIT_ASSISTANT_PROFILE_EVENT,
  schema: z.object({
    profile: z.enum(COCKPIT_ASSISTANT_PROFILE_IDS),
  }).strict(),
  maxBytes: 128,
  rateLimit: Object.freeze({ max: 12, windowMs: 10_000 }),
  retention: 'latest',
  route: 'handle',
  handle(event, effects = {}) {
    if (typeof effects.setAssistantProfile !== 'function') {
      throw new Error('Gateway does not support session Assistant Profile updates')
    }
    effects.setAssistantProfile(loadCockpitAssistantProfile(event.data.profile))
  },
})
