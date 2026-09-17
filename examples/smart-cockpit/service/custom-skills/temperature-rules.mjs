import { randomUUID } from 'node:crypto'

const TEMPERATURE_FIELDS = Object.freeze({
  acTemp: '主驾空调设定温度',
  passengerTemp: '副驾空调设定温度',
  rearTemp: '后排空调设定温度',
})
const TRIGGER_KEYS = new Set(['type', 'field', 'min', 'max'])

export function normalizeTemperatureTrigger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('event skill requires a temperature trigger')
  }
  if (Object.keys(value).some(key => !TRIGGER_KEYS.has(key))) {
    throw new TypeError('temperature trigger contains unsupported fields')
  }
  if (value.type !== 'vehicle_temperature') {
    throw new TypeError('only vehicle_temperature triggers are supported')
  }
  const field = value.field ?? 'acTemp'
  if (!Object.hasOwn(TEMPERATURE_FIELDS, field)) {
    throw new TypeError('unsupported temperature trigger field')
  }
  const trigger = { type: 'vehicle_temperature', field }
  for (const bound of ['min', 'max']) {
    if (value[bound] === undefined) continue
    if (
      typeof value[bound] !== 'number'
      || !Number.isFinite(value[bound])
      || value[bound] < 16
      || value[bound] > 32
    ) throw new TypeError(`trigger ${bound} must be a number between 16 and 32`)
    trigger[bound] = value[bound]
  }
  if (trigger.min === undefined && trigger.max === undefined) {
    throw new TypeError('temperature trigger requires min or max')
  }
  if (trigger.min !== undefined && trigger.max !== undefined && trigger.min > trigger.max) {
    throw new TypeError('temperature trigger min must not exceed max')
  }
  return trigger
}

export function temperatureRuleInstructions(trigger, reminder) {
  const range = trigger.min !== undefined && trigger.max !== undefined
    ? `${trigger.min}–${trigger.max}°C（含边界）`
    : trigger.max !== undefined
      ? `${trigger.max}°C及以下`
      : `${trigger.min}°C及以上`
  return `当${TEMPERATURE_FIELDS[trigger.field]}从条件外进入${range}时，提醒：${reminder}。创建或加载规则不改变温度，也不立即触发提醒。`
}

function matches(trigger, temperature) {
  return Number.isFinite(temperature)
    && (trigger.min === undefined || temperature >= trigger.min)
    && (trigger.max === undefined || temperature <= trigger.max)
}

/** Bounded scenario rules, not user code or a general workflow executor. */
export class TemperatureSkillRules {
  constructor({ store, listSkills, onTriggered }) {
    this.store = store
    this.listSkills = listSkills
    this.onTriggered = onTriggered
    this.cockpits = new Map()
  }

  async prepare(cockpitId = 'default') {
    const id = String(cockpitId || 'default').trim()
    const existing = this.cockpits.get(id)
    if (existing) return existing.ready
    const entry = {
      rules: [], previous: this.store.snapshot(id), ready: null,
      refreshChain: Promise.resolve(),
    }
    this.cockpits.set(id, entry)
    entry.unsubscribe = this.store.subscribe(id, event => this.#observe(entry, event))
    entry.ready = this.#load(entry, id).catch(error => {
      entry.unsubscribe()
      this.cockpits.delete(id)
      throw error
    })
    return entry.ready
  }

  async refresh(cockpitId = 'default') {
    const id = String(cockpitId || 'default').trim()
    await this.prepare(id)
    const entry = this.cockpits.get(id)
    const load = () => this.#load(entry, id)
    // Serialize per cockpit: a slow pre-delete read must not resurrect its rule
    // after the deletion's refresh has already completed.
    entry.refreshChain = entry.refreshChain.then(load, load)
    await entry.refreshChain
  }

  async #load(entry, cockpitId) {
    const skills = await this.listSkills(cockpitId)
    entry.rules = skills.filter(skill => skill.kind === 'event')
    // Loading or editing a rule observes no transition and never speaks.
    entry.previous = this.store.snapshot(cockpitId)
  }

  #observe(entry, event) {
    const previous = entry.previous
    entry.previous = event.state
    if (!event.changed.includes('vehicle')) return
    for (const skill of entry.rules) {
      const trigger = skill.trigger
      const temperature = event.state.vehicle[trigger.field]
      const previousTemperature = previous.vehicle[trigger.field]
      if (
        temperature === previousTemperature
        || matches(trigger, previousTemperature)
        || !matches(trigger, temperature)
      ) continue
      this.onTriggered({
        kind: 'event',
        category: 'custom_skills',
        status: 'skill_triggered',
        eventId: randomUUID(),
        cockpitId: event.cockpitId,
        skillId: skill.id,
        skillName: skill.name,
        message: skill.reminder,
        trigger: structuredClone(trigger),
        temperature,
        previousTemperature,
        stateVersion: event.version,
      })
    }
  }
}
