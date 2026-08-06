import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

// End-to-end wiring of the invisible-memory close hook: a real WebSocket
// client connects to the gateway endpoint and disconnects; the gateway must
// hand the owner/session pair to the extractor exactly once, and a hook
// failure must never break the close path.
function gatewayHarness({ memoryExtractor }) {
  const server = createServer()
  attachRealtimeGateway(server, {
    identityManager: {
      resolveUpgrade: () => ({ ownerId: 'owner-hook' }),
    },
    memoryStore: { list: () => [] },
    memoryExtractor,
    notesStore: null,
    coordinator: {},
    respondPermission: async () => ({}),
    permissionPolicy: {
      mode: () => 'ask',
      applyDecision: () => {},
      setMode: () => {},
    },
  })
  return server
}

async function connectAndClose(server, { sessionId }) {
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=${sessionId}`,
    { headers: { host: `127.0.0.1:${port}` } },
  )
  await new Promise((resolvePromise, rejectPromise) => {
    ws.once('open', resolvePromise)
    ws.once('error', rejectPromise)
  })
  const closed = new Promise(resolvePromise => ws.once('close', resolvePromise))
  ws.close()
  await closed
}

test('runs the memory extractor when a voice client disconnects', async t => {
  const runs = []
  const server = gatewayHarness({
    memoryExtractor: {
      maybeRun: input => {
        runs.push(input)
        return null
      },
    },
  })
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)))

  await connectAndClose(server, { sessionId: 'memory-hook' })

  // The close handler runs synchronously after the socket closes; poll
  // briefly to absorb event-loop scheduling.
  for (let attempt = 0; attempt < 20 && !runs.length; attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  assert.deepEqual(runs, [{ ownerId: 'owner-hook', sessionId: 'memory-hook' }])
})

test('a missing or failing extractor never breaks the close path', async t => {
  // No extractor at all: the optional chain must keep the close silent.
  const bare = gatewayHarness({ memoryExtractor: null })
  t.after(() => new Promise(resolvePromise => bare.close(resolvePromise)))
  await connectAndClose(bare, { sessionId: 'no-extractor' })

  // A throwing hook must not surface: maybeRun is specified to never throw,
  // but the gateway should also survive a misbehaving implementation.
  let threw = false
  const failing = gatewayHarness({
    memoryExtractor: {
      maybeRun: () => {
        threw = true
        throw new Error('extractor exploded')
      },
    },
  })
  t.after(() => new Promise(resolvePromise => failing.close(resolvePromise)))
  await connectAndClose(failing, { sessionId: 'failing-extractor' })
  for (let attempt = 0; attempt < 20 && !threw; attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  assert.equal(threw, true)
})
