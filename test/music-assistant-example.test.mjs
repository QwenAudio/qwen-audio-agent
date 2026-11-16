import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const verifyPath = fileURLToPath(new URL('../examples/music-assistant/verify.mjs', import.meta.url))
const ready = {
  type: 'session.ready',
  protocol_version: '7.0.0',
  session_id: 'music-assistant-test',
  capabilities: ['input.audio', 'input.text'],
}

async function runVerify(t, handleConnection, { token = '', rejectUpgrade = false } = {}) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: rejectUpgrade ? () => false : undefined,
  })
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const requests = []
  const messages = []
  server.on('connection', (socket, request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    socket.on('message', data => messages.push(JSON.parse(data.toString())))
    handleConnection(socket)
  })
  await once(server, 'listening')

  const child = spawn(process.execPath, [verifyPath, `ws://127.0.0.1:${server.address().port}`], {
    // Do not inherit developer credentials or Node startup options into the CLI.
    env: { QWEN_AUDIO_GATEWAY_ACCESS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
  const [code, signal] = await once(child, 'close')
  assert.equal(signal, null, `verify was killed instead of exiting: ${stderr}`)
  return { code, stdout, stderr, requests, messages }
}

function sendReady(socket) {
  socket.once('message', () => socket.send(JSON.stringify(ready)))
}

test('music assistant verify succeeds only after the session.ready handshake', { timeout: 20000 }, async t => {
  const result = await runVerify(t, sendReady)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /verify ok: session\.ready received/)
  assert.match(result.stdout, /protocol_version: 7\.0\.0/)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].type, 'session.hello')
  assert.deepEqual(result.messages[0].protocol, { min: '7.0.0', max: '7.0.0' })
  assert.match(result.requests[0].url, /^\/api\/realtime\?sessionId=music-assistant-verify-\d+$/)
  assert.equal(result.requests[0].authorization, undefined)
})

for (const code of [1000, 1011]) {
  test(`music assistant verify rejects a pre-handshake close with code ${code}`, { timeout: 20000 }, async t => {
    const result = await runVerify(t, socket => socket.close(code, 'no session.ready'))
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, new RegExp(`websocket closed before handshake: code=${code}`))
    assert.doesNotMatch(result.stdout, /verify ok/)
  })
}

test('music assistant verify rejects Gateway error events', { timeout: 20000 }, async t => {
  const result = await runVerify(t, socket => {
    socket.once('message', () => socket.send(JSON.stringify({ type: 'error', code: 'handshake_rejected' })))
  })
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /gateway error event:.*handshake_rejected/)
  assert.doesNotMatch(result.stdout, /verify ok/)
})

test('music assistant verify sends its access token as an Authorization header', { timeout: 20000 }, async t => {
  const token = 'synthetic-music-assistant-test-token'
  const result = await runVerify(t, sendReady, { token })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.requests[0].authorization, `Bearer ${token}`)
  assert.ok(!result.requests[0].url.includes(token))
  assert.ok(!(result.stdout + result.stderr).includes(token))
})

test('music assistant verify rejects WebSocket connection errors', { timeout: 20000 }, async t => {
  const result = await runVerify(t, () => {}, { rejectUpgrade: true })
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /websocket error:/)
  assert.doesNotMatch(result.stdout, /verify ok/)
})

test('music assistant verify times out without session.ready', { timeout: 20000 }, async t => {
  const result = await runVerify(t, () => {})
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /no session\.ready within 8s/)
  assert.equal(result.messages[0].type, 'session.hello')
  assert.doesNotMatch(result.stdout, /verify ok/)
})
