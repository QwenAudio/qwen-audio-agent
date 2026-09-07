import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOpenAiCompatibleTextCall,
} from '../src/providers/llm/openai-compatible-chat.mjs'

test('posts to OpenAI-compatible chat completions and surfaces errors', async () => {
  assert.equal(createOpenAiCompatibleTextCall({
    baseUrl: 'https://example.com/v1',
    apiKey: '',
  }), null)
  const requests = []
  const llmCall = createOpenAiCompatibleTextCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }
    },
  })
  assert.equal(await llmCall({ system: 's', user: 'u' }), '{}')
  assert.equal(requests[0].url, 'https://example.com/v1/chat/completions')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key')
  assert.equal(JSON.parse(requests[0].options.body).temperature, 0)

  const retriedRequests = []
  const compatible = createOpenAiCompatibleTextCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'strict-compatible-model',
    fetchImpl: async (url, options) => {
      retriedRequests.push({ url, options })
      return retriedRequests.length === 1
        ? { ok: false, status: 400, text: async () => 'unsupported temperature' }
        : {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '[]' } }] }),
          }
    },
  })
  assert.equal(await compatible({ system: 's', user: 'u' }), '[]')
  assert.equal(retriedRequests.length, 2)
  assert.equal(
    'temperature' in JSON.parse(retriedRequests[1].options.body),
    false,
  )

  const failing = createOpenAiCompatibleTextCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }),
  })
  await assert.rejects(
    () => failing({ system: 's', user: 'u' }),
    /text model request failed: 429 rate limited/,
  )
})
