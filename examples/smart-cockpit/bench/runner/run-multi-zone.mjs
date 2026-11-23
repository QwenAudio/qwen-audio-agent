// Opt-in live acceptance against a running demo. Uses a dedicated cockpitId
// (must match the Gateway's COCKPIT_ID); never resets the default cockpit.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { MULTI_ZONE_EVENT } from '../../gateway/multi-zone/events.mjs'

const gateway = process.env.COCKPIT_VALIDATION_GATEWAY || 'ws://127.0.0.1:18889/api/realtime'
const service = process.env.COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010'
const cockpitId = process.env.COCKPIT_ID || 'multi-zone-validation'
if (cockpitId === 'default') throw new Error('Live validation requires a dedicated cockpitId')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Live validation timed out')
    await sleep(30)
  }
}
let ready = false
const events = []
const client = new GatewayClient({
  url: `${gateway}?sessionId=multi-zone-${randomUUID()}`, createSocket: url => new WebSocket(url),
  clientType: 'web', clientInstanceId: `multi-zone-test-${randomUUID()}`, clientVersion: '2.1.0',
  capabilities: ['input.text', 'input.audio', 'client.events'], reconnect: false,
  configure: () => ({ textOnly: false, voiceEnabled: true, inputEnabled: true, outputEnabled: true }),
  onStatus: status => { ready = status.state === 'ready' },
  onEvent: event => events.push(event),
})
const publish = data => client.request('client.event.publish', { name: MULTI_ZONE_EVENT, data })
const snapshot = async () => (await fetch(`${service}/api/cockpit/state?cockpitId=${encodeURIComponent(cockpitId)}`)).json()
const report = []
try {
  client.start()
  await until(() => ready)
  await fetch(`${service}/api/cockpit/reset?cockpitId=${encodeURIComponent(cockpitId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await publish({ op: 'enable' })
  async function check(name, rows, expected, assertions) {
    const offset = events.length
    await publish({ op: 'text', rows })
    await until(() => events.slice(offset).filter(event => event.type === 'tool.call' && event.status === 'completed').length >= expected)
    await until(() => events.slice(offset).some(event => event.type === 'transcript.final' && event.role === 'assistant'))
    let vehicle
    const deadline = Date.now() + 20_000
    for (;;) {
      vehicle = (await snapshot()).vehicle
      try { assertions(vehicle); break } catch (error) {
        if (Date.now() > deadline) throw error
        await sleep(50)
      }
    }
    const trace = events.slice(offset)
    const inputs = trace.filter(event => event.type === 'transcript.final' && event.role === 'user')
    assert.equal(inputs.length, 1)
    report.push({ name, input: inputs[0].content, reply: trace.filter(event => event.type === 'transcript.final' && event.role === 'assistant').at(-1)?.content, calls: trace.filter(event => event.type === 'tool.call' && event.status === 'completed').map(event => ({ name: event.name, arguments: event.arguments, result: event.result })), vehicle })
  }
  if (!process.env.COCKPIT_VALIDATION_DIRECT_ONLY) {
    await check('independent', [{ zone: 'driver', text: '打开车窗' }, { zone: 'passenger', text: '温度调整到24度' }], 2, vehicle => {
      assert.equal(vehicle.windowFL, 1)
      assert.equal(vehicle.passengerTemp, 24)
    })
    await check('me-too', [{ zone: 'driver', text: '打开车窗' }, { zone: 'passenger', text: '我也要' }], 1, vehicle => {
      assert.equal(vehicle.windowFL, 1)
      assert.equal(vehicle.windowFR, 1)
    })
    await check('one-zone', [{ zone: 'rearLeft', text: '打开我的车窗' }], 1, vehicle => assert.equal(vehicle.windowRL, 1))
    await check('four-zones', [
      { zone: 'driver', text: '打开我的车窗' }, { zone: 'passenger', text: '温度调整到24度' },
      { zone: 'rearLeft', text: '打开我的座椅加热' }, { zone: 'rearRight', text: '我也要' },
    ], 3, vehicle => {
      assert.equal(vehicle.windowFL, 1)
      assert.equal(vehicle.passengerTemp, 24)
      assert.ok(vehicle.seatHeating.rearLeft > 0)
      assert.ok(vehicle.seatHeating.rearRight > 0)
    })
  }
  if (process.env.COCKPIT_VALIDATION_PCM) {
    const audio = readFileSync(process.env.COCKPIT_VALIDATION_PCM)
    if (!process.env.COCKPIT_VALIDATION_DIRECT_ONLY) {
      const offset = events.length
      let passengerSent = false
      for (let at = 0; at < audio.length; at += 3200) {
        await publish({ op: 'audio', audio: audio.subarray(at, at + 3200).toString('base64') })
        if (!passengerSent && events.slice(offset).some(event => event.type === 'client.state' && event.data?.driverSpeaking)) {
          await publish({ op: 'text', rows: [{ zone: 'passenger', text: '我也要' }] })
          passengerSent = true
        }
        await sleep(100)
      }
      await publish({ op: 'audio.stop' })
      await until(() => events.slice(offset).some(event => event.type === 'transcript.final' && event.role === 'user'))
      const input = events.slice(offset).find(event => event.type === 'transcript.final' && event.role === 'user').content
      assert.match(input, /【主驾】.*车窗/u)
      assert.match(input, /【副驾】我也要/u)
      await until(() => events.slice(offset).some(event => event.type === 'tool.call' && event.status === 'completed'))
      report.push({ name: 'real-ASR-plus-text', input, calls: events.slice(offset).filter(event => event.type === 'tool.call' && event.status === 'completed') })
    }
    await publish({ op: 'disable' })
    client.send({ type: 'unmute' })
    const directOffset = events.length
    for (let at = 0; at < audio.length; at += 3200) {
      client.send({ type: 'audio.append', audio: audio.subarray(at, at + 3200).toString('base64') })
      await sleep(100)
    }
    for (let i = 0; i < 15; i++) {
      client.send({ type: 'audio.append', audio: Buffer.alloc(3200).toString('base64') })
      await sleep(100)
    }
    await until(() => events.slice(directOffset).some(event => event.type === 'tool.call' && event.status === 'completed'))
    const direct = events.slice(directOffset)
    const directCall = direct.find(event => event.type === 'tool.call' && event.status === 'completed')
    assert.ok(!directCall.arguments.window || directCall.arguments.window === 'windowFL')
    assert.equal((await snapshot()).vehicle.windowFL, 1)
    if (process.env.COCKPIT_VALIDATION_DIRECT_ONLY) {
      const vehicle = (await snapshot()).vehicle
      assert.deepEqual([vehicle.windowFR, vehicle.windowRL, vehicle.windowRR], [0, 0, 0])
    }
    assert.ok(!direct.some(event => event.type === 'client.state' && event.data?.batch))
    report.push({ name: 'default-driver-direct-audio', calls: [directCall] })
    // Wait for actual reply audio, then prove a simulated request interrupts it.
    await until(() => events.slice(directOffset).some(event => event.type === 'audio.delta'))
    const interruptOffset = events.length
    await publish({ op: 'enable' })
    await check('interrupt-reply', [{ zone: 'driver', text: '关闭我的车窗' }, { zone: 'passenger', text: '我也要' }], 1, vehicle => {
      assert.equal(vehicle.windowFL, 0)
      assert.equal(vehicle.windowFR, 0)
    })
    assert.ok(events.slice(interruptOffset).some(event => event.type === 'playback.clear'))
  }
  console.log(JSON.stringify({ passed: report.length, cockpitId, report }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ passed: report.length, cockpitId, report, failure: error.message, errors: events.filter(event => event.type === 'error' || event.type === 'voice.connection' && event.state === 'unavailable'), toolCalls: events.filter(event => event.type === 'tool.call'), states: events.filter(event => event.type === 'client.state').slice(-3) }, null, 2))
  throw error
} finally { client.stop() }
