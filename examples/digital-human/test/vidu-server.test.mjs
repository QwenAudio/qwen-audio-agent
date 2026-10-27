import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { startExampleServer } from '../server/server.mjs'
import { validateViduImage, viduAvailability } from '../server/renderers/vidu.mjs'
import { createArtcToken } from '../server/renderers/artc-token.mjs'

const wait = async (fn, label = 'condition') => {
  const deadline = Date.now() + 3000
  while (!fn()) { if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function fixture(t, overrides = {}) {
  const posts = [], signals = [], pcm = [], pcmLives = [], upstreams = []
  const { onInit, ...providerOverrides } = overrides
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    posts.push({ body: JSON.parse(body), authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ live: { id: `live-${posts.length}` }, client_secret: 'private-control-secret' }))
  })
  const ws = new WebSocketServer({ server: http })
  ws.on('connection', (socket, req) => {
    upstreams.push(socket)
    let attempts = 0
    socket.on('message', (bytes, binary) => {
      if (binary) { pcm.push(Buffer.from(bytes)); pcmLives.push(req.url); return }
      const message = JSON.parse(bytes)
      signals.push(message)
      if (message.type === 1) {
        attempts++
        if (onInit) onInit(socket, message, attempts)
        else socket.send(JSON.stringify({ type: 2, payload: { conn_init_ack: attempts === 1
          ? { success: false, error_code: 'NOT_READY' } : { success: true } } }))
      }
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const options = { experimental: true, apiKey: 'vda_private', appId: 'test-app', appKey: 'private-artc-key',
    httpOrigin: `http://127.0.0.1:${http.address().port}`, wsOrigin: `ws://127.0.0.1:${http.address().port}`,
    retryMs: 5, initTimeoutMs: 2000, ...providerOverrides }
  const host = await startExampleServer({ port: 0, rendererId: 'vidu', providerOptions: options })
  const sockets = []
  const connect = async () => {
    const socket = new WebSocket(host.origin.replace('http:', 'ws:') + '/avatar', { origin: host.origin })
    const messages = []
    socket.on('message', data => messages.push(JSON.parse(data)))
    sockets.push(socket)
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return { socket, messages, send: message => socket.send(JSON.stringify(message)) }
  }
  t.after(async () => {
    sockets.forEach(s => s.terminate())
    await host.close()
    upstreams.forEach(s => s.terminate())
    await new Promise(resolve => ws.close(resolve))
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
  })
  return { options, posts, signals, pcm, pcmLives, upstreams, host, connect }
}

test('Vidu experimental gate and public metadata never create a paid session or expose credentials', async t => {
  const f = await fixture(t, { experimental: false })
  const config = await (await fetch(`${f.host.origin}/api/config`)).json()
  assert.equal(config.renderer.enabled, false)
  assert.ok(!JSON.stringify(config).includes('private'))
  const client = await f.connect()
  await wait(() => client.messages.length)
  assert.equal(client.messages[0].code, 'vidu_not_enabled')
  assert.equal(f.posts.length, 0)
  assert.equal(viduAvailability({ experimental: true }).enabled, false)
  assert.equal(viduAvailability({ ...f.options, experimental: true, host: 'other' }).enabled, false)
})

test('Vidu retries init, forwards long PCM, and seals input without claiming playback completion', async t => {
  const f = await fixture(t)
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  assert.equal(c.messages.find(m => m.type === 'session.ready').completionMode, 'unavailable')
  assert.equal(viduAvailability(f.options).completionMode, 'unavailable')
  c.send({ type: 'session.open', epoch: 0 })
  await wait(() => c.messages.some(m => m.type === 'vidu.session'))
  for (let generation = 1; generation <= 2; generation++) {
    const turn = { epoch: 0, responseId: `reply-${generation}`, generation }
    c.send({ type: 'turn.start', ...turn })
    for (let i = 0; i < 400; i++) c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: Buffer.alloc(4800, 1).toString('base64') })
    c.send({ type: 'audio.end', ...turn })
    await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.responseId === turn.responseId))
    const session = c.messages.find(m => m.type === 'vidu.session')
    assert.equal(session.epoch, 0)
    assert.ok(session.rtc.token)
    const token = JSON.parse(Buffer.from(session.rtc.token, 'base64'))
    assert.equal(token.appid, 'test-app')
    assert.ok(!JSON.stringify(c.messages).includes('private'))
    assert.ok(!c.messages.some(m => /drained|playback|completed/.test(m.type)))
    assert.equal(c.messages.find(m => m.type === 'vidu.turn' && m.responseId === turn.responseId).epoch, 0)
    assert.equal(c.messages.find(m => m.type === 'vidu.input_ended' && m.responseId === turn.responseId).epoch, 0)
    c.send({ type: 'turn.finish', ...turn })
    c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: 'AAAA' }) // quarantined
  }
  assert.equal(f.signals.filter(m => m.type === 7).length, 0)
  assert.equal(f.signals.filter(m => m.type === 5).length, 0)
  c.send({ type: 'session.close' })
  await wait(() => f.signals.some(m => m.type === 5))
  assert.equal(f.pcm.length, 800)
  assert.ok(f.posts.every(p => p.authorization === 'Token vda_private'))
  assert.equal(f.posts.length, 1)
  assert.equal(f.signals.filter(m => m.type === 1).length, 2)
})

test('cancel during session creation hangs up a late live without sending credentials or audio to the old response', async t => {
  let resolvePost
  let postStarted = false
  const late = new Promise(resolve => { resolvePost = resolve })
  const f = await fixture(t, { request: () => { postStarted = true; return late } })
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  c.send({ type: 'session.open', epoch: 0 })
  await wait(() => postStarted)
  c.send({ type: 'session.close' })
  await new Promise(resolve => setTimeout(resolve, 10))
  resolvePost({ ok: true, json: async () => ({ live: { id: 'late-live' }, client_secret: 'private-control-secret' }) })
  await wait(() => f.signals.some(m => m.type === 5))
  assert.ok(!c.messages.some(m => m.type === 'vidu.session'))
  assert.equal(f.pcm.length, 0)
})

test('Vidu expiry and reconnect produce fresh credentials; disconnect releases the owned live', async t => {
  const f = await fixture(t, { liveTimeoutMs: 300 })
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  c.send({ type: 'session.open', epoch: 0 })
  await wait(() => c.messages.some(m => m.type === 'renderer.error' && m.code === 'session_expired'))
  assert.equal(c.messages.find(m => m.code === 'session_expired').epoch, 0)
  c.socket.close()
  await wait(() => c.socket.readyState === WebSocket.CLOSED)
  const second = await f.connect()
  await wait(() => second.messages.some(m => m.type === 'session.ready'))
  second.send({ type: 'session.open', epoch: 0 })
  await wait(() => second.messages.some(m => m.type === 'vidu.session'))
  second.socket.close()
  await wait(() => f.signals.filter(m => m.type === 5).length === 2)
  assert.notEqual(f.posts[0].body.rtc_info.user_id, f.posts[1].body.rtc_info.user_id)
})

test('invalid PCM closes the turn with a redacted error, and image inputs are constrained', async t => {
  const f = await fixture(t)
  const c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  c.send({ type: 'turn.start', epoch: 0, responseId: 'r', generation: 1 })
  c.send({ type: 'audio.append', epoch: 0, responseId: 'r', generation: 1, sampleRate: 16000, audio: 'AAAA' })
  await wait(() => c.messages.some(m => m.type === 'renderer.error'))
  assert.ok(!JSON.stringify(c.messages).includes('private-control-secret'))
  for (const image of ['file:///etc/passwd', 'http://example.com/x.png', 'data:text/html;base64,AAAA']) assert.throws(() => validateViduImage(image))
  assert.throws(() => validateViduImage('data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')))
  assert.ok(validateViduImage('data:image/png;base64,AAAA'))
  const token = createArtcToken({ appId: 'id', appKey: 'secret', channelId: 'channel', userId: 'viewer', expiresAt: Math.floor(Date.now() / 1000) + 60 })
  assert.ok(!Buffer.from(token, 'base64').toString().includes('secret'))
})


test('session cancellation interrupts and hangs up the old live, then opens a new RTC channel', async t => {
  const f = await fixture(t), c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  const old = { epoch: 0, responseId: 'old', generation: 1 }, next = { epoch: 1, responseId: 'next', generation: 1 }
  c.send({ type: 'turn.start', ...old })
  c.send({ type: 'audio.append', ...old, sampleRate: 24000, audio: 'AQABAA==' })
  await wait(() => f.pcm.length === 1)
  c.send({ type: 'session.cancel', epoch: 0, reason: 'user_interruption' })
  c.send({ type: 'audio.append', ...old, sampleRate: 24000, audio: 'AwADAA==' })
  c.send({ type: 'session.open', epoch: 1 })
  c.send({ type: 'session.open', epoch: 0 }) // an old open cannot replace the current live
  c.send({ type: 'session.cancel', epoch: 0 })
  c.send({ type: 'audio.append', ...old, sampleRate: 24000, audio: 'BAAEAA==' })
  c.send({ type: 'turn.start', ...next })
  c.send({ type: 'audio.append', ...next, sampleRate: 24000, audio: 'AgACAA==' })
  c.send({ type: 'audio.end', ...next })
  await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.responseId === 'next'))
  await wait(() => f.pcm.length === 2)
  c.send({ type: 'turn.finish', ...next })
  assert.deepEqual(f.pcm, [Buffer.from('AQABAA==', 'base64'), Buffer.from('AgACAA==', 'base64')])
  assert.deepEqual(f.signals.filter(m => m.live_id === 'live-1').map(m => m.type), [1, 1, 7, 5])
  assert.equal(f.posts.length, 2)
  assert.notEqual(f.posts[0].body.rtc_info.channel_id, f.posts[1].body.rtc_info.channel_id)
  assert.notEqual(f.posts[0].body.rtc_info.user_id, f.posts[1].body.rtc_info.user_id)
  assert.match(f.pcmLives[0], /live-1/)
  assert.match(f.pcmLives[1], /live-2/)
  assert.deepEqual(c.messages.filter(m => m.type === 'vidu.session').map(m => m.epoch), [0, 1])
  assert.ok(!c.messages.some(m => m.type === 'renderer.error'))
})

test('PCM packets remain ordered across rapid normal response boundaries, with no padding or interrupt', async t => {
  const f = await fixture(t), c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  const packets = [Buffer.from([0, 0, 1, 128, 255, 127, 4, 0]), Buffer.alloc(960, 37), Buffer.from([0, 0, 5, 0])]
  for (let i = 0; i < packets.length; i++) {
    const turn = { epoch: 0, responseId: `bytes-${i}`, generation: i + 1 }
    c.send({ type: 'turn.start', ...turn })
    c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: packets[i].toString('base64') })
    c.send({ type: 'audio.end', ...turn })
  }
  await wait(() => f.pcm.length === 3)
  assert.deepEqual(f.pcm, packets)
  assert.deepEqual(f.signals.map(m => m.type), [1, 1])
})

test('cancelled HTTP allocation cannot delay a new epoch or deliver queued audio and credentials', async t => {
  let resolveOld, calls = 0
  const oldAllocation = new Promise(resolve => { resolveOld = resolve })
  const f = await fixture(t, { request: (...args) => ++calls === 1 ? oldAllocation : fetch(...args) })
  const c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  const old = { epoch: 0, responseId: 'old', generation: 1 }
  c.send({ type: 'turn.start', ...old })
  c.send({ type: 'audio.append', ...old, sampleRate: 24000, audio: 'AQABAA==' })
  await wait(() => calls === 1)
  c.send({ type: 'session.cancel', epoch: 0 })
  c.send({ type: 'session.open', epoch: 1 })
  const next = { epoch: 1, responseId: 'next', generation: 1 }
  c.send({ type: 'turn.start', ...next })
  c.send({ type: 'audio.append', ...next, sampleRate: 24000, audio: 'AgACAA==' })
  c.send({ type: 'audio.end', ...next })
  await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.epoch === 1))
  resolveOld({ ok: true, json: async () => ({ live: { id: 'late-live' }, client_secret: 'private-control-secret' }) })
  await wait(() => f.signals.some(m => m.live_id === 'late-live' && m.type === 5))
  assert.deepEqual(f.signals.filter(m => m.live_id === 'late-live').map(m => m.type), [7, 5])
  assert.deepEqual(c.messages.filter(m => m.type === 'vidu.session').map(m => m.epoch), [1])
  assert.ok(!c.messages.some(m => m.type === 'renderer.error' || m.epoch === 0))
  assert.deepEqual(f.pcm, [Buffer.from('AgACAA==', 'base64')])
  assert.equal(c.socket.readyState, WebSocket.OPEN)
})

test('a cancelled initialization rejection cannot close or report failure for its replacement', async t => {
  let rejectOld, calls = 0
  const oldAllocation = new Promise((_resolve, reject) => { rejectOld = reject })
  const f = await fixture(t, { request: (...args) => ++calls === 1 ? oldAllocation : fetch(...args) })
  const c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  await wait(() => calls === 1)
  c.send({ type: 'session.cancel', epoch: 0 })
  c.send({ type: 'session.open', epoch: 1 })
  await wait(() => c.messages.some(m => m.type === 'vidu.session' && m.epoch === 1))
  rejectOld(new Error('late private upstream error'))
  const turn = { epoch: 1, responseId: 'new', generation: 1 }
  c.send({ type: 'turn.start', ...turn })
  c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: 'AQABAA==' })
  c.send({ type: 'audio.end', ...turn })
  await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.epoch === 1))
  assert.ok(!c.messages.some(m => m.type === 'renderer.error'))
  assert.equal(c.socket.readyState, WebSocket.OPEN)
})

test('turn cancellation during NOT_READY fences the live and does not let its init callbacks affect the next epoch', async t => {
  const f = await fixture(t, { onInit(socket, message) {
    socket.send(JSON.stringify({ type: 2, payload: { conn_init_ack: message.live_id === 'live-1'
      ? { success: false, error_code: 'NOT_READY' } : { success: true } } }))
  } })
  const c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'session.open', epoch: 0 })
  const old = { epoch: 0, responseId: 'old', generation: 1 }
  c.send({ type: 'turn.start', ...old })
  c.send({ type: 'audio.append', ...old, sampleRate: 24000, audio: 'AQABAA==' })
  await wait(() => f.signals.some(m => m.live_id === 'live-1' && m.type === 1))
  c.send({ type: 'turn.cancel', ...old })
  c.send({ type: 'session.open', epoch: 1 })
  const next = { epoch: 1, responseId: 'new', generation: 1 }
  c.send({ type: 'turn.start', ...next })
  c.send({ type: 'audio.append', ...next, sampleRate: 24000, audio: 'AgACAA==' })
  c.send({ type: 'audio.end', ...next })
  await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.epoch === 1))
  await wait(() => f.upstreams[0].readyState === WebSocket.CLOSED)
  assert.deepEqual(f.signals.filter(m => m.live_id === 'live-1' && [7, 5].includes(m.type)).map(m => m.type), [7, 5])
  assert.ok(!c.messages.some(m => m.epoch === 0 || m.type === 'renderer.error'))
  assert.deepEqual(f.pcm, [Buffer.from('AgACAA==', 'base64')])
})

test('session commands require a nonnegative integer epoch', async t => {
  const f = await fixture(t)
  for (const epoch of [undefined, -1, 1.5, '1']) {
    const c = await f.connect()
    await wait(() => c.messages.length)
    c.send({ type: 'session.open', epoch })
    await wait(() => c.socket.readyState === WebSocket.CLOSED)
    assert.equal(c.messages.find(m => m.type === 'renderer.error').code, 'invalid_input')
  }
  assert.equal(f.posts.length, 0)
})

test('repeated cancellation cannot create unbounded concurrent live allocations', async t => {
  const rejects = []
  const f = await fixture(t, { request: () => new Promise((_resolve, reject) => rejects.push(reject)) })
  const c = await f.connect()
  await wait(() => c.messages.length)
  for (let epoch = 0; epoch < 4; epoch++) {
    c.send({ type: 'session.open', epoch })
    c.send({ type: 'session.cancel', epoch })
  }
  await wait(() => rejects.length === 4)
  c.send({ type: 'session.open', epoch: 4 })
  await wait(() => c.socket.readyState === WebSocket.CLOSED)
  for (const reject of rejects) reject(new Error('cancelled allocation'))
  assert.equal(rejects.length, 4)
  assert.equal(c.messages.find(m => m.type === 'renderer.error').code, 'invalid_input')
})
