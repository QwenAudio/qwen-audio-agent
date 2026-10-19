import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LlmBackendAdapter,
  createLlmBackendAdapter,
} from '../src/backend/adapters/llm/backend-adapter.mjs'
import { createAgentClient } from '../src/backend/adapters/agent-client.mjs'
import {
  verifyBackendAdapterConformance,
} from '../src/backend/backend-adapter-conformance.mjs'

function work(index = 1) {
  return {
    id: `llm-task-${index}`,
    ownerId: 'owner-1',
    instruction: `Answer LLM task ${index}`,
  }
}

function fakeFetch({ hold = false, content = 'LLM finished the task.' } = {}) {
  const started = Promise.withResolvers()
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    started.resolve()
    if (hold) {
      return new Promise((resolve, reject) => {
        const cancel = () => reject(options.signal.reason || new Error('aborted'))
        if (options.signal.aborted) cancel()
        else options.signal.addEventListener('abort', cancel, { once: true })
      })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, started: started.promise, calls }
}

function adapterOptions(fetchImpl) {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    timeoutMs: 0,
    fetchImpl,
  }
}

test('LLM backend adapter satisfies the public BackendPort contract', async () => {
  await verifyBackendAdapterConformance({
    createFixture: ({ hold }) => {
      const runtime = fakeFetch({ hold })
      return {
        name: 'LLM',
        backend: createLlmBackendAdapter(adapterOptions(runtime.fetchImpl)),
        work: work(1),
        nextWork: work(2),
        started: runtime.started,
      }
    },
  })
})

test('sends one stateless request without tools or Gateway metadata even when experimental work fields are supplied', async () => {
  const runtime = fakeFetch({ content: 'The direct answer.' })
  const backend = new LlmBackendAdapter({
    ...adapterOptions(runtime.fetchImpl),
    systemPrompt: 'Answer concisely.',
  })
  const outcome = await backend.submit({
    ...work(),
    objective: 'hidden fallback',
    continuity: 'shared',
    metadata: { private: true },
    tools: [{ type: 'function', function: { name: 'never_execute', parameters: { type: 'object' } } }],
    conversationContext: [{ role: 'user', content: 'private history' }],
    handoff: { user_evidence: [{ text: 'private evidence' }] },
  })
  assert.deepEqual(outcome, { content: 'The direct answer.', artifacts: [] })
  assert.equal(runtime.calls.length, 1)
  const [{ url, options }] = runtime.calls
  assert.equal(url, 'https://example.test/v1/chat/completions')
  assert.equal(options.headers.authorization, 'Bearer test-key')
  const body = JSON.parse(options.body)
  assert.deepEqual(body, {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'Answer concisely.' },
      { role: 'user', content: work().instruction },
    ],
    stream: false,
  })
  assert.equal('tools' in body, false)
  assert.equal(options.body.includes(work().id), false)
  assert.equal(options.body.includes(work().ownerId), false)
  await backend.close()
})

test('reports missing API configuration without making a request', async () => {
  const backend = new LlmBackendAdapter({
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
  })
  assert.equal(backend.describe().configured, false)
  const health = await backend.health()
  assert.equal(health.ok, false)
  assert.match(health.error, /API key is not configured/)
  await backend.close()
})

test('createAgentClient selects the LLM adapter', async () => {
  const runtime = fakeFetch()
  const client = createAgentClient({
    protocol: 'llm',
    timeoutMs: 0,
    llmFetch: runtime.fetchImpl,
    backends: {
      llm: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    },
  })
  assert.equal(client.protocol, 'llm')
  assert.equal((await client.submit(work())).content, 'LLM finished the task.')
  await client.close()
})

test('preserves HTTP status and bounded response body on API errors', async () => {
  const backend = new LlmBackendAdapter(adapterOptions(async () => new Response(
    JSON.stringify({ error: { message: 'invalid model' } }),
    { status: 400 },
  )))
  await assert.rejects(backend.submit(work()), error => {
    assert.equal(error.status, 400)
    assert.equal(error.protocol, 'llm')
    assert.match(error.body, /invalid model/)
    return true
  })
  await backend.close()
})
