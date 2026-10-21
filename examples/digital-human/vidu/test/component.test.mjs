import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createArtcToken } from '../artc-token.mjs'
import { createComponentServer } from '../component-server.mjs'

test('ARTC token follows the documented Base64 format and keeps AppKey out of it', () => {
  const encoded = createArtcToken({ appId: 'app', appKey: 'private-key', channelId: 'room', userId: 'viewer', expiresAt: Math.floor(Date.now() / 1000) + 100 })
  const value = JSON.parse(Buffer.from(encoded, 'base64').toString())
  assert.deepEqual(Object.keys(value), ['appid', 'channelid', 'userid', 'nonce', 'timestamp', 'token'])
  assert.equal(value.token, createHash('sha256').update(`appprivate-keyroomviewer${value.timestamp}`).digest('hex'))
  assert.equal(JSON.stringify(value).includes('private-key'), false)
})

test('component session signs two RTC users and forwards only audio/reply text and interruption', async t => {
  const signals = []
  const audio = []
  const requests = []
  const upstreamWs = new WebSocketServer({ noServer: true })
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ live: { id: 'component-123', status: 'waiting' }, client_secret: 'secret-control' }))
  })
  upstream.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.authorization, 'Token vda_test')
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('client_secret'), 'secret-control')
    upstreamWs.handleUpgrade(request, socket, head, client => {
      client.on('message', (bytes, binary) => {
        if (binary) { audio.push(Buffer.from(bytes)); return }
        const signal = JSON.parse(bytes.toString())
        signals.push(signal)
        if (signal.type === 1) client.send(JSON.stringify({
          type: 2,
          payload: { conn_init_ack: signals.filter(item => item.type === 1).length === 1 ? { success: false, error_code: 'NOT_READY' } : { success: true } },
        }))
      })
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => { upstreamWs.close(); upstream.close() })
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const app = createComponentServer({ viduKey: 'vda_test', appId: 'app-id', appKey: 'app-secret', httpOrigin: origin, wsOrigin: origin.replace('http:', 'ws:'), retryMs: 5 })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.address().port}`
  const created = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_uri: 'https://example.com/person.png' }),
  })
  assert.equal(created.status, 200)
  const result = await created.json()
  assert.equal(result.live.id, 'component-123')
  assert.equal(JSON.stringify(result).includes('app-secret'), false)
  assert.equal(JSON.stringify(result).includes('secret-control'), false)
  assert.equal(requests[0].url, '/live/s_avatar/component')
  assert.equal(requests[0].authorization, 'Token vda_test')
  assert.equal(requests[0].body.model, 'vidu-s2')
  assert.equal(requests[0].body.rtc_info.provider, 'artc')
  const viewer = JSON.parse(Buffer.from(result.rtc.token, 'base64').toString())
  const avatar = JSON.parse(Buffer.from(requests[0].body.rtc_info.token, 'base64').toString())
  assert.equal(viewer.channelid, avatar.channelid)
  assert.notEqual(viewer.userid, avatar.userid)
  assert.equal(avatar.userid, result.rtc.avatar_user_id)

  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/session?session_id=${result.session_id}`)
  await once(socket, 'open')
  const [warming] = await once(socket, 'message')
  assert.equal(JSON.parse(warming.toString()).event, 'warming')
  const [ready] = await once(socket, 'message')
  assert.equal(JSON.parse(ready.toString()).event, 'ready')
  socket.send(new Uint8Array([1, 0, 2, 0]))
  socket.send(JSON.stringify({ action: 'transcript', role: 'output', content: '你好' }))
  socket.send(JSON.stringify({ action: 'interrupt' }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(audio[0], Buffer.from([1, 0, 2, 0]))
  assert.deepEqual(signals.map(signal => signal.type), [1, 1, 10, 7])
  assert.equal(signals[2].payload.text_msg.content, '你好')
  socket.send(JSON.stringify({ action: 'hangup' }))
  await once(socket, 'close')
  assert.equal(signals.at(-1).type, 5)
})

async function fixture(t, options = {}) {
  const upstreamWs = new WebSocketServer({ noServer: true })
  const signals = []
  let connections = 0
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ live: { id: 'fixture-live', status: 'waiting' }, client_secret: 'private' }))
  })
  upstream.on('upgrade', (request, socket, head) => upstreamWs.handleUpgrade(request, socket, head, client => {
    connections++
    client.on('message', (bytes, binary) => {
      if (binary) return
      const message = JSON.parse(bytes.toString())
      signals.push(message)
      if (message.type === 1 && options.ack !== false) client.send(JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } }))
    })
  }))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const app = createComponentServer({ viduKey: 'vda_test', appId: 'app', appKey: 'secret',
    httpOrigin: origin, wsOrigin: origin.replace('http:', 'ws:'), ...options })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(async () => {
    await app.shutdown()
    for (const client of upstreamWs.clients) client.terminate()
    upstreamWs.close()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  const base = `http://127.0.0.1:${app.address().port}`
  const create = async () => (await fetch(`${base}/api/session`, { method: 'POST',
    body: JSON.stringify({ image_uri: 'https://example.com/avatar.png' }) })).json()
  const connect = result => new WebSocket(`${base.replace('http:', 'ws:')}/ws/session?session_id=${result.session_id}`)
  return { app, base, create, connect, signals, get connections() { return connections } }
}

test('rejects foreign browser origins on HTTP and WebSocket without creating a live', async t => {
  const f = await fixture(t)
  const response = await fetch(`${f.base}/api/session`, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })
  assert.equal(response.status, 403)
  const created = await f.create()
  const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws/session?session_id=${created.session_id}`, { origin: 'https://untrusted.example' })
  const [error] = await once(socket, 'error')
  assert.match(error.message, /404/)
  assert.equal(f.connections, 0)
})

test('rejects missing credentials, invalid image and oversized data before upstream use', async t => {
  const f = await fixture(t, { viduKey: '' })
  const response = await fetch(`${f.base}/api/session`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 503)
  const configured = await fixture(t)
  for (const [image_uri, expected] of [
    ['file:///tmp/avatar.png', 400],
    ['data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'), 413],
  ]) {
    const result = await fetch(`${configured.base}/api/session`, { method: 'POST', body: JSON.stringify({ image_uri }) })
    assert.equal(result.status, expected)
  }
})

test('cancelled and expired pending sessions cannot initialize a paid stream', async t => {
  const f = await fixture(t, { pendingTimeoutMs: 30 })
  const deleted = await f.create()
  assert.notEqual(deleted.session_id, deleted.live.id)
  const response = await fetch(`${f.base}/api/session/${deleted.session_id}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  const socket = f.connect(deleted)
  assert.match((await once(socket, 'error'))[0].message, /404/)
  const expired = await f.create()
  await new Promise(resolve => setTimeout(resolve, 50))
  const other = f.connect(expired)
  assert.match((await once(other, 'error'))[0].message, /404/)
  assert.equal(f.connections, 0)
})

test('initialization timeout closes both control connections', async t => {
  const f = await fixture(t, { ack: false, initTimeoutMs: 30 })
  const socket = f.connect(await f.create())
  const [bytes] = await once(socket, 'message')
  assert.equal(JSON.parse(bytes).event, 'error')
  await once(socket, 'close')
  assert.equal(f.signals.at(-1).type, 5)
})

test('malformed PCM ends a live and server shutdown hangs up active sessions', async t => {
  const f = await fixture(t)
  const socket = f.connect(await f.create())
  await once(socket, 'message')
  socket.send(Buffer.from([1]))
  assert.match(JSON.parse((await once(socket, 'message'))[0]).message, /PCM/)
  await once(socket, 'close')
  const next = f.connect(await f.create())
  await once(next, 'message')
  const closed = once(next, 'close')
  await f.app.shutdown()
  await closed
  assert.equal(f.signals.at(-1).type, 5)
})
