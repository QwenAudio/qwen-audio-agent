// Scene-owned GCP payloads. No provider protocol or model prompt belongs here.
export const NAVIGATION_PREFERENCE_EVENT = 'cockpit.navigation.preference_changed'
export const SKILL_TRIGGERED_EVENT = 'cockpit.skill.triggered'

export function navigationPreferenceEvent(result, cockpitId = 'default') {
  const navigation = result?.data?.navigation
  if (!result?.changed?.includes('navigation') || !navigation) return null
  return {
    name: NAVIGATION_PREFERENCE_EVENT,
    delivery_hint: 'context',
    data: {
      cockpitId,
      stateVersion: result.stateVersion,
      strategy: navigation.strategy,
      status: navigation.status,
      destination: navigation.destination || null,
    },
  }
}

export function navigationPreferenceSnapshot(state, cockpitId = 'default') {
  if (!state?.navigation || !state.version) return null
  return navigationPreferenceEvent({
    changed: ['navigation'], data: { navigation: state.navigation }, stateVersion: state.version,
  }, cockpitId)
}

export function skillTriggeredEvent(activity, cockpitId = 'default') {
  if (activity?.category !== 'custom_skills'
    || activity.status !== 'skill_triggered'
    || activity.cockpitId !== cockpitId
    || !activity.eventId) return null
  return {
    event_id: activity.eventId,
    name: SKILL_TRIGGERED_EVENT,
    delivery_hint: 'respond',
    data: {
      cockpitId,
      stateVersion: activity.stateVersion,
      skillId: activity.skillId,
      skillName: activity.skillName,
      reminder: activity.message,
      trigger: activity.trigger,
      temperature: activity.temperature,
      previousTemperature: activity.previousTemperature,
    },
  }
}

// Small, bounded scene outbox: keep the latest context while connecting/muted;
// never replay old reminders after a long disconnection. GCP owns wire IDs.
export class CockpitEnvironmentOutbox {
  constructor({ now = Date.now, maxItems = 16, reminderTtlMs = 30_000 } = {}) {
    this.now = now
    this.maxItems = maxItems
    this.reminderTtlMs = reminderTtlMs
    this.pending = new Map()
    this.context = new Map()
    this.flushing = false
  }

  enqueue(event) {
    if (!event) return
    const key = event.delivery_hint === 'context' ? event.name : event.event_id
    if (!key) return
    if (event.delivery_hint === 'context') {
      this.context.set(key, event)
    }
    this.pending.set(key, { event, at: this.now() })
    while (this.pending.size > this.maxItems) this.pending.delete(this.pending.keys().next().value)
  }

  restoreContext() {
    for (const event of this.context.values()) this.enqueue(event)
  }

  async flush(send, isReady) {
    if (this.flushing || !isReady()) return
    this.flushing = true
    try {
      while (this.pending.size) {
        const [key, entry] = this.pending.entries().next().value
        if (!isReady()) break
        if (entry.event.delivery_hint !== 'context' && this.now() - entry.at > this.reminderTtlMs) {
          this.pending.delete(key)
          continue
        }
        const accepted = await send(entry.event)
        if (!accepted) break
        if (this.pending.get(key) === entry) this.pending.delete(key)
      }
    } finally {
      this.flushing = false
    }
  }
}
