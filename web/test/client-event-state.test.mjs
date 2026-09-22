import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientEventState } from '../src/realtime/client-event-state.js'

test('publishes changed environment state once, never once per frame or render', () => {
  const sent = []
  const states = new ClientEventState((name, data) => { sent.push({ name, data }); return true })
  states.set('media.visual_input.changed', { state: 'inactive' })
  assert.equal(sent.length, 0)
  states.setReady(true)
  states.set('media.visual_input.changed', { state: 'active' })
  states.set('media.visual_input.changed', { state: 'active' })
  states.setReady(true)
  assert.deepEqual(sent.map(event => event.data.state), ['inactive', 'active'])
})

test('reconnect resends only latest client state, including camera closed while disconnected', () => {
  const sent = []
  const states = new ClientEventState((name, data) => { sent.push({ name, data }); return true })
  states.setReady(true)
  states.set('media.visual_input.changed', { state: 'active' })
  states.setReady(false)
  states.set('media.visual_input.changed', { state: 'inactive' })
  states.set('environment.room.changed', { room: 'living' })
  assert.equal(sent.length, 1)
  states.setReady(true)
  assert.deepEqual(sent.slice(1), [
    { name: 'media.visual_input.changed', data: { state: 'inactive' } },
    { name: 'environment.room.changed', data: { room: 'living' } },
  ])
  states.setReady(false)
  states.setReady(true)
  assert.deepEqual(sent.slice(3), sent.slice(1, 3))
})

test('does not lose a state rejected by the transport before readiness', () => {
  let accept = false
  const sent = []
  const states = new ClientEventState((_name, data) => { sent.push(data); return accept })
  states.setReady(true)
  const data = { state: 'inactive' }
  states.set('media.visual_input.changed', data)
  data.state = 'active'
  accept = true
  states.setReady(true)
  assert.deepEqual(sent, [{ state: 'inactive' }, { state: 'inactive' }])
})
