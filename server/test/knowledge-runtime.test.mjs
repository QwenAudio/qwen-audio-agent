import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendKnowledgeRuntime } from '../src/frontend/knowledge/knowledge-runtime.mjs'

function fixture({ retrieve, health, close } = {}) {
  return {
    describe: () => ({
      protocolVersion: 1,
      key: 'fixture',
      label: 'Fixture Provider',
      capabilities: { filters: true },
    }),
    retrieve: retrieve || (async () => ({ results: [] })),
    ...(health ? { health } : {}),
    ...(close ? { close } : {}),
  }
}

test('keeps model request fields separate from trusted Gateway context', async () => {
  let received
  const runtime = new FrontendKnowledgeRuntime({
    provider: fixture({
      retrieve: async (request, context) => {
        received = { request, context }
        return {
          results: [{
            id: 'chunk_1',
            content: 'Provider answer',
            source: { id: 'doc_1', title: 'Guide' },
          }],
        }
      },
    }),
  })
  const response = await runtime.search('  user question ', {
    ownerId: 'owner-private',
    sessionId: 'session-private',
    turnId: 'turn-private',
    traceId: 'trace-private',
    knowledgeBaseIds: ['kb_one'],
    filters: { language: 'zh' },
    topK: 99,
  })

  assert.deepEqual(received.request, {
    query: 'user question',
    topK: 8,
    knowledgeBaseIds: ['kb_one'],
    filters: { language: 'zh' },
  })
  assert.equal(received.request.ownerId, undefined)
  assert.equal(received.context.ownerId, 'owner-private')
  assert.equal(received.context.sessionId, 'session-private')
  assert.equal(received.context.turnId, 'turn-private')
  assert.equal(received.context.traceId, 'trace-private')
  assert.equal(received.context.signal instanceof AbortSignal, true)
  assert.equal(response.results[0].content, 'Provider answer')
})

test('exposes capability, descriptor, optional health, and close lifecycle', async () => {
  let closed = false
  const runtime = new FrontendKnowledgeRuntime({
    provider: fixture({
      health: async () => ({ status: 'ready' }),
      close: async () => { closed = true },
    }),
  })
  assert.deepEqual(runtime.capabilities(), ['knowledge'])
  assert.deepEqual(runtime.describe(), {
    configured: true,
    capabilities: ['knowledge'],
    provider: {
      protocolVersion: 1,
      key: 'fixture',
      label: 'Fixture Provider',
      capabilities: { filters: true },
    },
  })
  assert.deepEqual(await runtime.health(), { status: 'ready', ok: true })
  await runtime.close()
  await runtime.close()
  assert.equal(closed, true)
})

test('rejects empty queries and aborts a provider at the configured timeout', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    timeoutMs: 10,
    provider: fixture({
      retrieve: async (_request, { signal }) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason)
          }, { once: true })
        })
        return []
      },
    }),
  })
  await assert.rejects(() => runtime.search(''), error => (
    error.code === 'knowledge_query_required'
  ))
  await assert.rejects(() => runtime.search('slow', { ownerId: 'owner' }), error => (
    error?.name === 'TimeoutError'
  ))
})

test('requires Gateway-owned identity and times out providers that ignore abort', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    timeoutMs: 10,
    provider: fixture({
      retrieve: async () => new Promise(() => {}),
    }),
  })
  await assert.rejects(() => runtime.search('query'), error => (
    error.code === 'knowledge_owner_required'
  ))
  await assert.rejects(
    () => runtime.search('query', { ownerId: 'owner' }),
    error => error?.name === 'TimeoutError',
  )
})

test('does not invoke a provider for an already-aborted request', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort(new DOMException('cancelled', 'AbortError'))
  const runtime = new FrontendKnowledgeRuntime({
    provider: fixture({
      retrieve: async () => {
        calls += 1
        return []
      },
    }),
  })
  await assert.rejects(
    () => runtime.search('query', {
      ownerId: 'owner',
      signal: controller.signal,
    }),
    error => error?.name === 'AbortError',
  )
  assert.equal(calls, 0)
})
