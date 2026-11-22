import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitInputRouter } from '../src/projections/multi-zone-input.js'

test('mode changes pause audio until acknowledged and send every frame to exactly one path', async () => {
  const requests = [], sent = []
  let acknowledge
  const client = { request: (_type, value) => { requests.push(value); return new Promise(resolve => { acknowledge = resolve }) }, send: event => { sent.push(event); return true } }
  const router = new CockpitInputRouter(client)
  const normal = router.setMode(false)
  assert.equal(router.audio('AA=='), false)
  await normal
  assert.equal(requests.length, 0, 'ordinary driver mode needs no extension handshake')
  router.audio('AA==')
  const enable = router.setMode(true)
  assert.equal(router.audio('BB=='), false)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(requests.at(-1).data.op, 'enable')
  acknowledge({ accepted: true })
  await enable
  router.audio('CC==')
  assert.deepEqual(sent.map(e => e.type), ['audio.append', 'audio.append'])
  assert.equal(sent[1].audio, 'CC==')
})

test('normal mode cannot submit simulated passenger text', async () => {
  const router = new CockpitInputRouter({ request: async () => ({ accepted: true }) })
  await router.setMode(false)
  await assert.rejects(router.text([{ zone: 'passenger', text: '开窗' }]), /尚未就绪/u)
})

test('simulated passenger text needs no microphone frame or driver turn after mode acknowledgement', async () => {
  const requests = []
  const router = new CockpitInputRouter({ request: async (type, value) => {
    requests.push({ type, ...value })
    return { accepted: true }
  } })
  await router.setMode(true)
  for (const zone of ['passenger', 'rearLeft', 'rearRight']) {
    await router.text([{ zone, text: '打开我的车窗' }])
  }
  assert.deepEqual(requests.map(request => request.data.op), ['enable', 'text', 'text', 'text'])
  assert.deepEqual(requests.slice(1).map(request => request.data.rows[0].zone), ['passenger', 'rearLeft', 'rearRight'])
})
