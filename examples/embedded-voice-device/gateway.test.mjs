import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { createDeviceGateway } from './gateway.mjs'
import { WebSocket, WebSocketServer } from 'ws'
const deadline = setTimeout(() => {
  console.error('Device gateway test timed out')
  process.exit(1)
}, 15000)
const token = 'test-upstream-access-token-0123456789'
const upstream = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`)
  res.setHeader('Content-Type', 'application/json')
  res.end(
    JSON.stringify({
      ok: true,
      voiceConfigured: true,
      privateDetail: 'must-not-leak',
    }),
  )
})
const remote = new WebSocketServer({ server: upstream })
remote.on('connection', (ws, req) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`)
  ws.on('message', (m) => ws.send(m.toString()))
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const target = `http://127.0.0.1:${upstream.address().port}`
for (const requireToken of [false, true]) {
  const server = createDeviceGateway({
    WebSocket,
    WebSocketServer,
    upstream: target,
    accessToken: token,
    requireToken,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  let response = await fetch(base + '/api/health')
  assert.equal(response.status, requireToken ? 401 : 200)
  response = await fetch(base + '/api/health', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const health = await response.json()
  assert.equal(health.ok, true)
  assert.equal(health.privateDetail, undefined)
  assert.equal((await fetch(base + '/api/access/devices')).status, 404)
  assert.equal(
    (
      await fetch(base + '/api/health', {
        headers: { Authorization: 'Bearer wrong' },
      })
    ).status,
    401,
  )
  const headers = requireToken ? { Authorization: `Bearer ${token}` } : {}
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/realtime', {
    headers,
  })
  await once(ws, 'open')
  const message = once(ws, 'message')
  ws.send('{"type":"session.hello"}')
  assert.equal((await message)[0].toString(), '{"type":"session.hello"}')
  // Pause/resume controls must cross the device ingress unchanged and in order.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const type of [
      'response.cancel',
      'input.mute',
      'wake',
      'input.unmute',
    ]) {
      const payload = JSON.stringify({ type, event_id: `mic_${cycle}_${type}` })
      const echoed = once(ws, 'message')
      ws.send(payload)
      assert.equal((await echoed)[0].toString(), payload)
    }
  }
  const pcm = Buffer.alloc(19200)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251
  const chunks = []
  const received = new Promise((resolve) =>
    ws.on('message', (data) => {
      const e = JSON.parse(data)
      if (e.type === 'audio.delta') {
        chunks.push(e)
        if (
          chunks.reduce(
            (n, c) => n + Buffer.from(c.audio, 'base64').length,
            0,
          ) === pcm.length
        )
          resolve()
      }
    }),
  )
  ws.send(
    JSON.stringify({
      type: 'audio.delta',
      event_id: 'audio_test',
      responseId: 'response_test',
      sampleRate: 24000,
      audio: pcm.toString('base64'),
    }),
  )
  await received
  assert.ok(chunks.length > 1)
  assert.ok(
    chunks.every(
      (c) =>
        c.audio.length <= 4096 &&
        c.responseId === 'response_test' &&
        c.sampleRate === 24000,
    ),
  )
  assert.equal(new Set(chunks.map((c) => c.event_id)).size, chunks.length)
  assert.deepEqual(
    Buffer.concat(chunks.map((c) => Buffer.from(c.audio, 'base64'))),
    pcm,
  )
  // Hold a device reader while a provider bursts more than the old 256 KB limit.
  const burstPcm = Buffer.alloc(600000, 37),
    burstChunks = []
  const burstDone = new Promise((resolve) => {
    const onMessage = (data) => {
      const e = JSON.parse(data)
      if (e.responseId !== 'slow_response') return
      burstChunks.push(Buffer.from(e.audio, 'base64'))
      if (burstChunks.reduce((n, c) => n + c.length, 0) === burstPcm.length) {
        ws.off('message', onMessage)
        resolve()
      }
    }
    ws.on('message', onMessage)
  })
  ws.pause()
  // Send directly from the simulated provider, bypassing device input size limits.
  const provider = [...remote.clients][0]
  provider.send(
    JSON.stringify({
      type: 'audio.delta',
      event_id: 'slow_audio',
      responseId: 'slow_response',
      sampleRate: 24000,
      audio: burstPcm.toString('base64'),
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(ws.readyState, WebSocket.OPEN)
  ws.resume()
  await burstDone
  assert.deepEqual(Buffer.concat(burstChunks), burstPcm)
  ws.close()
  await once(ws, 'close')
  const bad = new WebSocket(base.replace('http:', 'ws:') + '/api/realtime', {
    headers: { Origin: 'https://untrusted.example', ...headers },
  })
  await new Promise((resolve) => {
    bad.on('unexpected-response', (_, r) => {
      assert.equal(r.statusCode, 401)
      r.resume()
      bad.terminate()
      resolve()
    })
    bad.on('error', () => {})
  })
  await new Promise((resolve) => server.close(resolve))
}
for (const ws of remote.clients) ws.terminate()
remote.close()
await new Promise((resolve) => upstream.close(resolve))
clearTimeout(deadline)
console.log(
  'Device gateway: optional/required token, private upstream auth, origin rejection, route isolation, and bidirectional relay PASS',
)
