import assert from 'node:assert/strict'
import test from 'node:test'
import { EvaScenarios } from '../eva-scenarios.mjs'

const definitions = [
  { name: 'read_booking', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'change_booking', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
]

test('EVA scenario exposes only read tools to the frontend', () => {
  const scenarios = new EvaScenarios({
    origin: 'http://127.0.0.1:1', token: 'secret', sessionId: 'eva-1',
    policy: 'policy', definitions, currentDateTime: '2026-01-01 00:00:00',
  })
  assert.deepEqual(scenarios.definitions('eva-1', 'frontend').map(tool => tool.name), ['read_booking'])
  assert.deepEqual(scenarios.definitions('eva-1', 'backend').map(tool => tool.name),
    ['read_booking', 'change_booking'])
})

test('EVA writes require an exact preview token before commit', async t => {
  const calls = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    calls.push(request)
    return new Response(JSON.stringify({
      result: { status: 'success', action: request.action }, hash: 'db-hash',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const scenarios = new EvaScenarios({
    origin: 'http://127.0.0.1:1', token: 'secret', sessionId: 'eva-1',
    policy: 'policy', definitions, currentDateTime: '2026-01-01 00:00:00',
  })

  const preview = await scenarios.execute('eva-1', 'change_booking', { booking: 'ABC' })
  assert.equal(preview.data.needsApproval, true)
  assert.equal(calls[0].action, 'preview')
  await assert.rejects(
    scenarios.execute('eva-1', 'change_booking', {
      booking: 'DIFFERENT', approval_token: preview.data.approval.token,
    }), /Mismatched or expired EVA approval/,
  )
  assert.equal(calls.length, 1)

  const second = await scenarios.execute('eva-1', 'change_booking', { booking: 'ABC' })
  const committed = await scenarios.execute('eva-1', 'change_booking', {
    booking: 'ABC', approval_token: second.data.approval.token,
  })
  assert.equal(committed.data.operationCommitted, true)
  assert.equal(calls.at(-1).action, 'commit')
  assert.equal(calls.at(-1).hash, 'db-hash')
})

test('EVA read calls execute immediately without approval', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).action, 'execute')
    return new Response(JSON.stringify({ result: { status: 'success' } }), { status: 200 })
  }
  const scenarios = new EvaScenarios({
    origin: 'http://127.0.0.1:1', token: 'secret', sessionId: 'eva-1',
    policy: 'policy', definitions, currentDateTime: '2026-01-01 00:00:00',
  })
  const result = await scenarios.execute('eva-1', 'read_booking', { booking: 'ABC' }, 'frontend')
  assert.equal(result.data.changed, false)
})
