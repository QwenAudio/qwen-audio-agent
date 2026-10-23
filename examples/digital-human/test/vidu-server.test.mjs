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
  const posts = [], signals = [], pcm = [], upstreams = []
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    posts.push({ body: JSON.parse(body), authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ live: { id: `live-${posts.length}` }, client_secret: 'private-control-secret' }))
  })
  const ws = new WebSocketServer({ server: http })
  ws.on('connection', socket => {
    upstreams.push(socket)
    let attempts = 0
    socket.on('message', (bytes, binary) => {
      if (binary) { pcm.push(Buffer.from(bytes)); return }
      const message = JSON.parse(bytes)
      signals.push(message)
      if (message.type === 1) socket.send(JSON.stringify({ type: 2, payload: { conn_init_ack: ++attempts === 1
        ? { success: false, error_code: 'NOT_READY' } : { success: true } } }))
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const options = { experimental: true, apiKey: 'vda_private', appId: 'test-app', appKey: 'private-artc-key',
    httpOrigin: `http://127.0.0.1:${http.address().port}`, wsOrigin: `ws://127.0.0.1:${http.address().port}`,
    retryMs: 5, initTimeoutMs: 300, ...overrides }
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
  return { options, posts, signals, pcm, host, connect }
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

test('Vidu retries init, forwards long PCM, seals input without fabricating drain, and isolates multiple live sessions', async t => {
  const f = await fixture(t)
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  for (let generation = 1; generation <= 2; generation++) {
    const turn = { responseId: `reply-${generation}`, generation }
    c.send({ type: 'turn.start', ...turn })
    for (let i = 0; i < 400; i++) c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: Buffer.alloc(4800, 1).toString('base64') })
    c.send({ type: 'audio.end', ...turn })
    await wait(() => c.messages.some(m => m.type === 'vidu.input_ended' && m.responseId === turn.responseId))
    const session = c.messages.find(m => m.type === 'vidu.session' && m.responseId === turn.responseId)
    assert.ok(session.rtc.token)
    const token = JSON.parse(Buffer.from(session.rtc.token, 'base64'))
    assert.equal(token.appid, 'test-app')
    assert.ok(!JSON.stringify(c.messages).includes('private'))
    assert.ok(!c.messages.some(m => /drained|playback|completed/.test(m.type)))
    c.send({ type: 'turn.cancel', ...turn, reason: 'user_interruption' })
    c.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: 'AAAA' }) // quarantined
  }
  await wait(() => f.signals.filter(m => m.type === 5).length === 2)
  assert.equal(f.pcm.length, 800)
  assert.ok(f.posts.every(p => p.authorization === 'Token vda_private'))
  assert.notEqual(f.posts[0].body.rtc_info.channel_id, f.posts[1].body.rtc_info.channel_id)
  assert.equal(f.signals.filter(m => m.type === 1).length, 4)
})

test('cancel during session creation hangs up a late live without sending credentials or audio to the old response', async t => {
  let resolvePost
  let postStarted = false
  const late = new Promise(resolve => { resolvePost = resolve })
  const f = await fixture(t, { request: () => { postStarted = true; return late } })
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  c.send({ type: 'turn.start', responseId: 'old', generation: 1 })
  await wait(() => postStarted)
  c.send({ type: 'turn.cancel', responseId: 'old', generation: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))
  resolvePost({ ok: true, json: async () => ({ live: { id: 'late-live' }, client_secret: 'private-control-secret' }) })
  await wait(() => f.signals.some(m => m.type === 5))
  assert.ok(!c.messages.some(m => m.type === 'vidu.session'))
  assert.equal(f.pcm.length, 0)
})

test('Vidu expiry and reconnect produce fresh credentials; disconnect releases the owned live', async t => {
  const f = await fixture(t, { liveTimeoutMs: 60 })
  const c = await f.connect()
  await wait(() => c.messages.some(m => m.type === 'session.ready'))
  c.send({ type: 'turn.start', responseId: 'r1', generation: 1 })
  await wait(() => c.messages.some(m => m.type === 'renderer.error' && m.code === 'session_expired'))
  c.socket.close()
  await wait(() => c.socket.readyState === WebSocket.CLOSED)
  const second = await f.connect()
  await wait(() => second.messages.some(m => m.type === 'session.ready'))
  second.send({ type: 'turn.start', responseId: 'r2', generation: 1 })
  await wait(() => second.messages.some(m => m.type === 'vidu.session'))
  second.socket.close()
  await wait(() => f.signals.filter(m => m.type === 5).length === 2)
  assert.notEqual(f.posts[0].body.rtc_info.user_id, f.posts[1].body.rtc_info.user_id)
})

test('invalid PCM closes the turn with a redacted error, and image inputs are constrained', async t => {
  const f = await fixture(t)
  const c = await f.connect()
  await wait(() => c.messages.length)
  c.send({ type: 'turn.start', responseId: 'r', generation: 1 })
  c.send({ type: 'audio.append', responseId: 'r', generation: 1, sampleRate: 16000, audio: 'AAAA' })
  await wait(() => c.messages.some(m => m.type === 'renderer.error'))
  assert.ok(!JSON.stringify(c.messages).includes('private-control-secret'))
  for (const image of ['file:///etc/passwd', 'http://example.com/x.png', 'data:text/html;base64,AAAA']) assert.throws(() => validateViduImage(image))
  assert.throws(() => validateViduImage('data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')))
  assert.ok(validateViduImage('data:image/png;base64,AAAA'))
  const token = createArtcToken({ appId: 'id', appKey: 'secret', channelId: 'channel', userId: 'viewer', expiresAt: Math.floor(Date.now() / 1000) + 60 })
  assert.ok(!Buffer.from(token, 'base64').toString().includes('secret'))
})
