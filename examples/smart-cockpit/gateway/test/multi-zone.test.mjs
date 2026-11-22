import assert from 'node:assert/strict'
import test from 'node:test'
import { MultiZoneCoordinator } from '../multi-zone/coordinator.mjs'
import { CockpitSmartTurn } from '../multi-zone/smart-turn.mjs'
import { createMultiZoneEvents, MULTI_ZONE_EVENT } from '../multi-zone/events.mjs'
import { GatewayEventRouter, ClientEventDefinitionRegistry } from 'qwen-audio-agent/client-events'
import { createCockpitFrontendMcpConfiguration } from '../profile-bundle.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
test('seat attribution and cross-zone semantics live in vehicle tool policies independently of persona', () => {
  const tools = createCockpitFrontendMcpConfiguration({ frontendMcpUrl: 'http://cockpit.test/mcp' }).servers.cockpit.tools
  for (const name of ['vehicle_window_control', 'vehicle_temperature_control', 'vehicle_comfort_control']) {
    assert.match(tools[name].description, /没有音区标签.*主驾/u)
    assert.match(tools[name].description, /我也要/u)
  }
  assert.match(tools.vehicle_window_control.description, /windowFL\/windowFR\/windowRL\/windowRR/u)
  assert.match(tools.vehicle_temperature_control.description, /driver\/passenger\/rear\/rear/u)
})
function harness(t, options = {}) {
  const inputs = [], collecting = [], states = []
  const coordinator = new MultiZoneCoordinator({
    submit: parts => inputs.push(parts[0].text), collect: active => collecting.push(active), publish: state => states.push(state), mergeMs: 10, timeoutMs: 500, ...options,
  })
  t.after(() => coordinator.close())
  return { coordinator, inputs, collecting, states }
}

test('two zones wait for both turn ends AND final ASR, preserving start order rather than ASR completion order', async t => {
  const h = harness(t)
  h.coordinator.start('driver', 'a')
  h.coordinator.start('passenger', 'b')
  h.coordinator.final('passenger', 'b', '我也要')
  h.coordinator.end('driver', 'a')
  h.coordinator.final('driver', 'a', '打开车窗')
  await sleep(25)
  assert.deepEqual(h.inputs, [])
  h.coordinator.end('passenger', 'b')
  await sleep(25)
  assert.deepEqual(h.inputs, ['【主驾】打开车窗\n【副驾】我也要'])
  assert.deepEqual(h.collecting, [true, false])
})

test('one zone submits alone; joining during the merge window resets the barrier', async t => {
  const h = harness(t, { mergeMs: 25 })
  h.coordinator.text([{ zone: 'passenger', text: '温度调到24度' }], 'one')
  await sleep(40)
  assert.deepEqual(h.inputs, ['【副驾】温度调到24度'])
  h.coordinator.text([{ zone: 'driver', text: '打开车窗' }], 'two')
  h.coordinator.start('rearLeft', 'later')
  await sleep(40)
  assert.equal(h.inputs.length, 1)
  h.coordinator.end('rearLeft', 'later')
  h.coordinator.final('rearLeft', 'later', '我也要')
  await sleep(40)
  assert.equal(h.inputs[1], '【主驾】打开车窗\n【左后】我也要')
})

test('four-zone atomic text, duplicate sends and late ASR never replay an action', async t => {
  const h = harness(t)
  const rows = ['driver', 'passenger', 'rearLeft', 'rearRight'].map(zone => ({ zone, text: '打开车窗' }))
  h.coordinator.text(rows, 'same')
  h.coordinator.text(rows, 'same')
  await sleep(25)
  assert.equal(h.inputs.length, 1)
  assert.equal(h.inputs[0].split('\n').length, 4)
  h.coordinator.start('driver', 'same:driver')
  h.coordinator.final('driver', 'same:driver', '关闭车窗')
  await sleep(25)
  assert.equal(h.inputs.length, 1)
})

test('timeout and disconnect release collection without executing incomplete input', async t => {
  const h = harness(t, { timeoutMs: 15 })
  h.coordinator.start('driver', 'unfinished')
  h.coordinator.text([{ zone: 'passenger', text: '我也要' }])
  await sleep(30)
  assert.deepEqual(h.inputs, [])
  assert.equal(h.states.at(-1).history[0].status, 'failed')
  h.coordinator.text([{ zone: 'driver', text: '打开车窗' }])
  h.coordinator.close()
  await sleep(25)
  assert.deepEqual(h.inputs, [])
  assert.equal(h.collecting.at(-1), false)
})

function smartHarness(t) {
  let bridge
  const h = harness(t, { beforeSubmit: () => bridge.waitForIdle() })
  bridge = new CockpitSmartTurn({ coordinator: h.coordinator, publish() {} })
  t.after(() => bridge.close())
  return { ...h, bridge }
}
const start = id => ({ type: 'input_audio_buffer.speech_started', item_id: id })
const end = id => ({ type: 'input_audio_buffer.speech_stopped', item_id: id })
const final = (id, transcript) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript })
const created = id => ({ type: 'response.created', response: { id } })
const cancelled = id => ({ type: 'response.done', response: { id, status: 'cancelled' } })

test('a lone driver keeps native Smart Turn without opening a text collection or replay', async t => {
  const h = smartHarness(t)
  h.bridge.receive(start('driver'))
  h.bridge.receive(final('driver', '打开车窗'))
  h.bridge.receive(end('driver'))
  h.bridge.receive(created('native'))
  h.bridge.receive(cancelled('native'))
  await sleep(25)
  assert.deepEqual(h.inputs, [])
  assert.deepEqual(h.collecting, [])
})

test('overlap waits for native Smart Turn stop, final ASR and automatic-response cancellation confirmation', async t => {
  const h = smartHarness(t)
  h.bridge.receive(start('driver'))
  h.bridge.text([{ zone: 'passenger', text: '我也要' }], 'passenger')
  h.bridge.receive(final('driver', '打开车窗'))
  await sleep(25)
  assert.deepEqual(h.inputs, [], 'final ASR alone must not end Smart Turn')
  h.bridge.receive(end('driver'))
  await sleep(25)
  assert.deepEqual(h.inputs, [], 'speech stop alone must not bypass the automatic response')
  h.bridge.receive(created('automatic'))
  await sleep(25)
  assert.deepEqual(h.inputs, [], 'must wait for response.done after cancel')
  h.bridge.receive(cancelled('automatic'))
  await sleep(25)
  assert.deepEqual(h.inputs, ['【主驾】打开车窗\n【副驾】我也要'])
})

test('text-first collection includes a driver joining within the merge window', async t => {
  const h = smartHarness(t)
  h.bridge.text([{ zone: 'passenger', text: '温度调到24度' }])
  h.bridge.receive(start('driver'))
  h.bridge.receive(end('driver'))
  h.bridge.receive(created('automatic'))
  h.bridge.receive(cancelled('automatic'))
  await sleep(25)
  assert.deepEqual(h.inputs, [], 'late final ASR is still required')
  h.bridge.receive(final('driver', '打开车窗'))
  await sleep(25)
  assert.deepEqual(h.inputs, ['【副驾】温度调到24度\n【主驾】打开车窗'])
})

test('Smart Turn invalid speech is discarded without blocking an independent passenger request', async t => {
  const h = smartHarness(t)
  h.bridge.receive(start('driver'))
  h.bridge.text([{ zone: 'passenger', text: '打开我的车窗' }])
  h.bridge.receive({ ...end('driver'), reason: 'turn_invalid' })
  await sleep(25)
  assert.deepEqual(h.inputs, ['【副驾】打开我的车窗'])
})

test('a failed driver transcript cannot turn an overlapping follow-up into a partial action', async t => {
  const h = smartHarness(t)
  h.bridge.receive(start('driver'))
  h.bridge.text([{ zone: 'passenger', text: '我也要' }])
  h.bridge.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'driver' })
  await sleep(25)
  assert.deepEqual(h.inputs, [])
  assert.equal(h.coordinator.snapshot().history[0].status, 'failed')
})

test('provider disconnect clears old speech so a later passenger request can start independently', async t => {
  const h = smartHarness(t)
  h.bridge.receive(start('old-driver'))
  h.bridge.text([{ zone: 'passenger', text: '我也要' }])
  h.bridge.receive({ type: 'session.disconnected' })
  assert.equal(h.bridge.busy(), false)
  assert.equal(h.coordinator.snapshot().history[0].status, 'failed')
  h.bridge.text([{ zone: 'passenger', text: '打开我的车窗' }])
  await sleep(25)
  assert.deepEqual(h.inputs, ['【副驾】打开我的车窗'])
})

function eventHarness(t) {
  const extension = createMultiZoneEvents({ mergeMs: 10 })
  t.after(() => extension.close())
  const router = new GatewayEventRouter({ registry: new ClientEventDefinitionRegistry(extension) })
  const inputs = [], cleanups = [], external = [], collecting = [], listeners = [], states = []
  const effects = {
    setExternalInput: value => external.push(value),
    setInputCollecting: value => collecting.push(value),
    submitInput: parts => inputs.push(parts[0].text),
    publishClientState: (_name, state) => states.push(state), appendAudio() {},
    onRealtimeEvent: listener => { listeners.push(listener); return () => {} },
    onDisconnect: cleanup => { cleanups.push(cleanup); return () => {} },
  }
  let counter = 0
  const publish = (data, owner = 'a') => router.publish({ event_id: 'event_' + (++counter), name: MULTI_ZONE_EVENT, data }, { source: { ownerId: owner, sessionId: 'main' }, effects })
  return { publish, inputs, cleanups, external, collecting, listeners, states }
}

test('non-wake seats start independently while the driver remains the native wake zone', async t => {
  const h = eventHarness(t)
  await h.publish({ op: 'enable' })
  assert.deepEqual(h.external, [], 'opening the screen does not switch provider mode')
  for (const [zone, label] of [['passenger', '副驾'], ['rearLeft', '左后'], ['rearRight', '右后']]) {
    await h.publish({ op: 'text', rows: [{ zone, text: '打开我的车窗' }] })
    await sleep(25)
    assert.equal(h.inputs.at(-1), '【' + label + '】打开我的车窗')
  }
  assert.equal(h.inputs.length, 3)
  // Independent passenger requests never take over the central audio path:
  // the next driver turn still uses native Smart Turn without text replay.
  const receive = h.listeners[0]
  receive(start('wake-driver'))
  receive(end('wake-driver'))
  receive(final('wake-driver', '关闭车窗'))
  receive(created('native-wake-reply'))
  receive({ type: 'response.done', response: { id: 'native-wake-reply', status: 'completed' } })
  await sleep(25)
  assert.equal(h.inputs.length, 3, 'the fixed wake zone must not be converted into a text batch')
  assert.ok(h.states.length > 0)
  assert.ok(h.states.every(state => state.wakeZone === 'driver'))
  assert.equal(h.listeners.length, 1, 'one native observer remains bound to the central session')
  assert.deepEqual(h.collecting, [true, false, true, false, true, false])
})

test('registered events validate seats, isolate batches and prevent delayed submission on disconnect', async t => {
  const h = eventHarness(t)
  await h.publish({ op: 'enable' })
  await h.publish({ op: 'enable' }, 'b')
  await assert.rejects(h.publish({ op: 'text', rows: [{ zone: 'invalid', text: '开窗' }] }))
  await h.publish({ op: 'text', rows: [{ zone: 'driver', text: '打开车窗' }] })
  await h.publish({ op: 'text', rows: [{ zone: 'passenger', text: '温度24度' }] }, 'b')
  h.cleanups[0]()
  await sleep(25)
  assert.deepEqual(h.inputs, ['【副驾】温度24度'])
  await h.publish({ op: 'disable' }, 'b')
  assert.equal(h.external.at(-1), false)
})
