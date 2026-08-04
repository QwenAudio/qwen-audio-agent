import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import {
  DesktopHostClient,
  DesktopHostClientError,
} from '../src/desktop-host-client.mjs'
import { encodeDesktopHostMessage } from '../../shared/desktop-host-protocol.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.writes = []
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.writes.push(String(chunk))
      callback()
    },
  })
  child.killed = 0
  child.kill = () => {
    child.killed += 1
    queueMicrotask(() => child.emit('exit', 1, null))
    return true
  }
  child.sendMessage = message => {
    child.stdout.write(encodeDesktopHostMessage(message))
  }
  child.requests = () => child.writes
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  return child
}

function hello(overrides = {}) {
  return {
    event: 'hello',
    data: {
      protocol: 1,
      packageVersion: '1.2.0',
      nodeVersion: '22.22.2',
      distribution: 'Ubuntu',
      ...overrides,
    },
  }
}

async function readyClient(options = {}) {
  const child = fakeChild()
  const client = new DesktopHostClient({
    child,
    helloTimeoutMs: 100,
    requestTimeoutMs: 100,
    ...options,
  })
  child.sendMessage(hello())
  assert.deepEqual(await client.waitForHello(), hello().data)
  return { child, client }
}

test('waits for hello and correlates out-of-order responses by string id', async () => {
  const { child, client } = await readyClient()
  const first = client.request('runtime.status', {})
  const second = client.request('settings.read', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(child.requests().map(request => request.id), ['1', '2'])

  child.sendMessage({ id: '2', ok: true, result: { order: 2 } })
  child.sendMessage({ id: '1', ok: true, result: { order: 1 } })
  assert.deepEqual(await Promise.all([first, second]), [
    { order: 1 },
    { order: 2 },
  ])
  assert.equal(client.closed, false)
})

test('times out only the affected request and keeps the bridge usable', async () => {
  const { child, client } = await readyClient({ requestTimeoutMs: 10 })
  await assert.rejects(
    client.request('runtime.status', {}, { timeoutMs: 5 }),
    error => error.code === 'request_timeout',
  )

  const next = client.request('settings.read', {}, { timeoutMs: 100 })
  await new Promise(resolve => setImmediate(resolve))
  child.sendMessage({ id: '2', ok: true, result: { settings: {} } })
  assert.deepEqual(await next, { settings: {} })
  assert.equal(client.closed, false)
})

for (const responseKind of ['unknown', 'duplicate']) {
  test(`${responseKind} response ids are terminal protocol errors`, async () => {
    const { child, client } = await readyClient()
    if (responseKind === 'duplicate') {
      const request = client.request('runtime.status', {})
      await new Promise(resolve => setImmediate(resolve))
      child.sendMessage({ id: '1', ok: true, result: {} })
      await request
    }
    const terminal = new Promise(resolve => client.once('error', resolve))
    child.sendMessage({
      id: responseKind === 'duplicate' ? '1' : '999',
      ok: true,
      result: {},
    })
    const error = await terminal
    assert.equal(error.code, 'unexpected_response_id')
    assert.equal(client.closed, true)
    assert.equal(child.killed, 1)
  })
}

test('rejects hello and every pending request when the child exits', async () => {
  const child = fakeChild()
  child.spawnargs = ['token=must-not-leak']
  const client = new DesktopHostClient({ child, helloTimeoutMs: 100 })
  const helloPromise = client.waitForHello()
  const pending = client.request('runtime.status', {})
  child.emit('exit', 7, null)

  await assert.rejects(helloPromise, error => (
    error.code === 'host_exit'
    && !error.message.includes('must-not-leak')
  ))
  await assert.rejects(pending, error => error.code === 'host_exit')
})

test('bounds and redacts line-oriented stderr diagnostics', async () => {
  const { child, client } = await readyClient({
    maxDiagnosticLines: 3,
    maxDiagnosticLineBytes: 32,
  })
  child.stderr.write('first\nsecond token=secret\nthird\nfourth-is-longer-than-the-limit-ignored\n')
  await new Promise(resolve => setImmediate(resolve))
  const diagnostics = client.tailDiagnostics()
  assert.equal(diagnostics.length, 3)
  assert.equal(diagnostics.some(line => line.includes('secret')), false)
  assert.equal(diagnostics.at(-1).length <= 32, true)
})

for (const badOutput of ['not-json\n', `${'x'.repeat(300)}\n`]) {
  test('terminates the bridge on malformed or oversized stdout', async () => {
    const { child, client } = await readyClient({ maxLineBytes: 256 })
    const terminal = new Promise(resolve => client.once('error', resolve))
    child.stdout.write(badOutput)
    const error = await terminal
    assert.equal(error instanceof DesktopHostClientError, true)
    assert.equal(error.code, 'protocol_error')
    assert.equal(client.closed, true)
    assert.equal(child.killed, 1)
  })
}

test('forwards host events and performs authenticated graceful shutdown', async () => {
  const sessionToken = 'ab'.repeat(32)
  const { child, client } = await readyClient({ sessionToken })
  const statuses = []
  client.on('status', value => statuses.push(value))
  child.sendMessage({
    event: 'gateway.status',
    data: { state: 'recovering', retry: 1 },
  })
  assert.deepEqual(statuses, [{ state: 'recovering', retry: 1 }])

  const shutdown = client.shutdown()
  await new Promise(resolve => setImmediate(resolve))
  const request = child.requests().at(-1)
  assert.deepEqual(request, {
    id: '1',
    method: 'host.shutdown',
    params: { sessionToken },
  })
  child.sendMessage({ id: '1', ok: true, result: { shuttingDown: true } })
  child.emit('exit', 0, null)
  await shutdown
  assert.equal(client.closed, true)
  assert.equal(child.killed, 0)
})
