import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CockpitService } from '../cockpit-service.mjs'
import { CustomSkillStore } from '../custom-skills/store.mjs'
import { CockpitStateStore } from '../state-store.mjs'
import { TemperatureSkillRules } from '../custom-skills/temperature-rules.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qwen-temperature-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const customSkills = new CustomSkillStore({ root })
  const service = new CockpitService({ customSkills })
  const events = []
  service.subscribeActivity('car-one', event => {
    if (event.status === 'skill_triggered') events.push(event)
  })
  return { root, customSkills, service, events }
}

const ruleInput = {
  name: '低温提醒',
  description: '主驾空调较低时提醒',
  kind: 'event',
  trigger: { type: 'vehicle_temperature', max: 19 },
  reminder: '当前温度较低，当心感冒',
}
const createRule = (service, input = ruleInput, cockpitId = 'car-one') => (
  service.execute('custom_skill_create', input, { cockpitId })
)
const setTemperature = (service, temperature, zone = 'driver', cockpitId = 'car-one') => (
  service.execute('vehicle_temperature_control', { action: 'set', temperature, zone }, { cockpitId })
)

test('fires only on entry into a temperature condition, including manual state mutations', async t => {
  const { service, events } = await fixture(t)
  const result = await createRule(service)
  assert.equal(result.data.skill.kind, 'event')
  assert.equal(service.snapshot('car-one').vehicle.acTemp, 25)
  assert.equal(events.length, 0)
  await setTemperature(service, 20)
  await setTemperature(service, 19)
  assert.equal(events.length, 1)
  assert.equal(events[0].temperature, 19)
  assert.equal(events[0].previousTemperature, 20)
  assert.equal(events[0].stateVersion, service.snapshot('car-one').version)
  assert.equal(events[0].skillId, result.data.skill.id)
  assert.equal(events[0].skillName, '低温提醒')
  assert.equal(events[0].message, ruleInput.reminder)
  assert.equal(events[0].kind, 'event')
  assert.equal(events[0].category, 'custom_skills')
  assert.deepEqual(events[0].trigger, { type: 'vehicle_temperature', field: 'acTemp', max: 19 })
  await setTemperature(service, 19)
  await setTemperature(service, 18)
  assert.equal(events.length, 1)
  service.store.update('car-one', ['vehicle'], next => { next.vehicle.acTemp = 21 })
  service.store.update('car-one', ['vehicle'], next => { next.vehicle.acTemp = 19 })
  assert.equal(events.length, 2)
  assert.notEqual(events[0].eventId, events[1].eventId)
})

test('creating or loading a rule while already matching never fabricates a change', async t => {
  const { service, events } = await fixture(t)
  await setTemperature(service, 19)
  const version = service.snapshot('car-one').version
  await createRule(service)
  const loaded = await service.execute('custom_skill_load', { skill_name: '低温提醒' }, { cockpitId: 'car-one' })
  assert.match(loaded.content, /加载不触发提醒/u)
  assert.equal(service.snapshot('car-one').version, version)
  await setTemperature(service, 18)
  assert.equal(events.length, 0)
  await setTemperature(service, 20)
  await setTemperature(service, 19)
  assert.equal(events.length, 1)
})

test('editing and deleting a rule updates the armed rules before returning', async t => {
  const { service, events } = await fixture(t)
  const created = await createRule(service)
  await setTemperature(service, 19)
  const updated = await createRule(service, {
    ...ruleInput,
    trigger: { type: 'vehicle_temperature', max: 18 },
    reminder: '十八度提醒',
  })
  assert.equal(updated.data.skill.id, created.data.skill.id)
  assert.equal(events.length, 1)
  await setTemperature(service, 20)
  await setTemperature(service, 19)
  assert.equal(events.length, 1)
  await setTemperature(service, 18)
  assert.equal(events.length, 2)
  assert.equal(events.at(-1).message, '十八度提醒')
  await service.deleteSkill('car-one', created.data.skill.id)
  await setTemperature(service, 20)
  await setTemperature(service, 18)
  assert.equal(events.length, 2)
})

test('temperature fields, inclusive ranges and cockpit identities remain isolated', async t => {
  const { service, events } = await fixture(t)
  const otherEvents = []
  service.subscribeActivity('car-two', event => otherEvents.push(event))
  await createRule(service, {
    ...ruleInput,
    trigger: { type: 'vehicle_temperature', field: 'passengerTemp', min: 19, max: 21 },
  })
  await setTemperature(service, 20)
  await setTemperature(service, 20, 'passenger', 'car-two')
  assert.equal(events.length, 0)
  assert.equal(otherEvents.filter(event => event.status === 'skill_triggered').length, 0)
  await setTemperature(service, 21, 'passenger')
  await setTemperature(service, 20, 'passenger')
  assert.equal(events.length, 1)
  await setTemperature(service, 18, 'passenger')
  await setTemperature(service, 19, 'passenger')
  assert.equal(events.length, 2)
})

test('a new service reads persisted rules and arms before its first temperature command', async t => {
  const { root, service } = await fixture(t)
  await createRule(service)
  const rebuilt = new CockpitService({ customSkills: new CustomSkillStore({ root }) })
  const events = []
  rebuilt.subscribeActivity('car-one', event => {
    if (event.status === 'skill_triggered') events.push(event)
  })
  await setTemperature(rebuilt, 19)
  assert.equal(events.length, 1)
  await setTemperature(rebuilt, 19)
  assert.equal(events.length, 1)
  const alreadyColdStore = new CockpitStateStore()
  alreadyColdStore.update('car-one', ['vehicle'], next => { next.vehicle.acTemp = 18 })
  const cold = new CockpitService({ store: alreadyColdStore, customSkills: new CustomSkillStore({ root }) })
  const coldEvents = []
  cold.subscribeActivity('car-one', event => {
    if (event.status === 'skill_triggered') coldEvents.push(event)
  })
  await setTemperature(cold, 19)
  assert.equal(coldEvents.length, 0)
  await setTemperature(cold, 20)
  await setTemperature(cold, 19)
  assert.equal(coldEvents.length, 1)
})

test('slow persisted-rule loading cannot lose the first authoritative temperature change', async t => {
  const { customSkills } = await fixture(t)
  await customSkills.upsert('car-one', ruleInput)
  let release
  let notifyLoading
  const gate = new Promise(resolve => { release = resolve })
  const loading = new Promise(resolve => { notifyLoading = resolve })
  const service = new CockpitService({ customSkills: {
    async list(cockpitId) {
      notifyLoading()
      await gate
      return customSkills.list(cockpitId)
    },
  } })
  const events = []
  service.subscribeActivity('car-one', event => events.push(event))
  const command = setTemperature(service, 19)
  await loading
  assert.equal(service.snapshot('car-one').vehicle.acTemp, 25)
  release()
  await command
  assert.equal(events.filter(event => event.status === 'skill_triggered').length, 1)
})

test('a slow older cache refresh cannot resurrect a deleted rule', async () => {
  const store = new CockpitStateStore()
  const events = []
  let skills = [{
    ...ruleInput, id: 'saved-rule',
    trigger: { type: 'vehicle_temperature', field: 'acTemp', max: 19 },
  }]
  let reads = 0
  let release
  let notifyOldRead
  const oldRead = new Promise(resolve => { notifyOldRead = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const rules = new TemperatureSkillRules({
    store,
    async listSkills() {
      const captured = structuredClone(skills)
      if (++reads === 2) {
        notifyOldRead()
        await gate
      }
      return captured
    },
    onTriggered: event => events.push(event),
  })
  await rules.prepare('car-one')
  const older = rules.refresh('car-one')
  await oldRead
  skills = []
  const deletion = rules.refresh('car-one')
  release()
  await Promise.all([older, deletion])
  store.update('car-one', ['vehicle'], next => { next.vehicle.acTemp = 19 })
  assert.equal(events.length, 0)
  assert.equal(reads, 3)
})
