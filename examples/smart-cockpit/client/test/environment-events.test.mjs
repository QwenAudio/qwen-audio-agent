import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CockpitEnvironmentOutbox,
  navigationPreferenceEvent,
  navigationPreferenceSnapshot,
  skillTriggeredEvent,
} from '../src/projections/environment-events.js'

const preference = (strategy = 5, version = 2) => navigationPreferenceSnapshot({
  version, navigation: { strategy, status: 'idle', destination: null },
}, 'car-one')
const reminder = id => ({
  event_id: id, name: 'cockpit.skill.triggered', delivery_hint: 'respond', data: {},
})

test('projects authoritative navigation facts, not optimistic button state', () => {
  assert.equal(navigationPreferenceEvent({ changed: [] }), null)
  assert.equal(navigationPreferenceSnapshot(null), null)
  assert.deepEqual(preference().data, {
    cockpitId: 'car-one', stateVersion: 2, strategy: 5, status: 'idle', destination: null,
  })
  assert.equal(preference().delivery_hint, 'context')
})

test('projects only this cockpit’s service-confirmed skill event with its stable id', () => {
  const activity = {
    category: 'custom_skills', status: 'skill_triggered', cockpitId: 'car-one',
    eventId: 'temperature-crossing-one', stateVersion: 3, skillId: 'cold', skillName: '低温提醒',
    message: '温度较低，请注意舒适度', trigger: { type: 'vehicle_temperature', field: 'acTemp', max: 19 },
    temperature: 19, previousTemperature: 20,
  }
  assert.equal(skillTriggeredEvent(activity, 'car-two'), null)
  assert.equal(skillTriggeredEvent({ ...activity, status: 'working' }, 'car-one'), null)
  const event = skillTriggeredEvent(activity, 'car-one')
  assert.equal(event.event_id, activity.eventId)
  assert.equal(event.data.reminder, activity.message)
  assert.equal(event.delivery_hint, 'respond')
})

test('retains only latest context while unavailable and restores it after reconnect', async () => {
  const outbox = new CockpitEnvironmentOutbox()
  outbox.enqueue(preference(5))
  outbox.enqueue(preference(13, 3))
  const sent = []
  const send = async event => { sent.push(event); return true }
  await outbox.flush(send, () => false)
  assert.equal(sent.length, 0)
  await outbox.flush(send, () => true)
  assert.deepEqual(sent.map(event => event.data.strategy), [13])
  outbox.restoreContext()
  await outbox.flush(send, () => true)
  assert.deepEqual(sent.map(event => event.data.strategy), [13, 13])
  // Service reset restarts its version; the latest authoritative snapshot wins.
  outbox.enqueue(preference(0, 1))
  await outbox.flush(send, () => true)
  assert.equal(sent.at(-1).data.strategy, 0)
})

test('drains a context replacement made while an earlier send is in flight', async () => {
  const outbox = new CockpitEnvironmentOutbox()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const sent = []
  const send = async event => {
    sent.push(event.data.strategy)
    if (sent.length === 1) await gate
    return true
  }
  outbox.enqueue(preference(5))
  const flush = outbox.flush(send, () => true)
  outbox.enqueue(preference(13, 3))
  await outbox.flush(send, () => true)
  release()
  await flush
  assert.deepEqual(sent, [5, 13])
  assert.equal(outbox.pending.size, 0)
})

test('bounds pending events, expires stale reminders, and never restores spoken reminders', async () => {
  let now = 0
  const outbox = new CockpitEnvironmentOutbox({ now: () => now, maxItems: 3 })
  for (const id of ['a', 'b', 'c', 'd']) outbox.enqueue(reminder(id))
  assert.equal(outbox.pending.size, 3)
  now = 30_001
  outbox.enqueue(preference())
  const sent = []
  const send = async event => { sent.push(event); return true }
  await outbox.flush(send, () => true)
  assert.deepEqual(sent.map(event => event.delivery_hint), ['context'])
  outbox.enqueue(reminder('new'))
  await outbox.flush(send, () => true)
  outbox.restoreContext()
  await outbox.flush(send, () => true)
  assert.equal(sent.filter(event => event.event_id === 'new').length, 1)
})

test('retains failed sends for retry and stops draining when the session becomes muted', async () => {
  const outbox = new CockpitEnvironmentOutbox()
  outbox.enqueue(preference())
  await outbox.flush(async () => false, () => true)
  assert.equal(outbox.pending.size, 1)
  outbox.enqueue(reminder('next'))
  let ready = true
  await outbox.flush(async () => { ready = false; return true }, () => ready)
  assert.equal(outbox.pending.size, 1)
  await outbox.flush(async () => true, () => true)
  assert.equal(outbox.pending.size, 0)
})
