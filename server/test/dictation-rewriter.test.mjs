import assert from 'node:assert/strict'
import test from 'node:test'
import { createStatelessRewriter } from '../src/dictation/stateless-rewriter.mjs'

test('sends one stateless text request with no tools or memory context', async () => {
  const requests = []
  const rewrite = createStatelessRewriter({
    baseUrl: 'https://example.test/compatible-mode/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) })
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'Concise draft' } }] }
        },
      }
    },
  })

  assert.equal(await rewrite('Long draft', 'make it concise'), 'Concise draft')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://example.test/compatible-mode/v1/chat/completions')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(requests[0].body, {
    model: 'qwen-flash',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Rewrite only the supplied draft. Return only rewritten text.',
      },
      {
        role: 'user',
        content: 'Instruction:\nmake it concise\n\nDraft:\nLong draft',
      },
    ],
  })
  assert.equal('tools' in requests[0].body, false)
  assert.equal('memory' in requests[0].body, false)
})

test('rejects unavailable or empty rewrite responses without changing the draft', async () => {
  const unavailable = createStatelessRewriter({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  await assert.rejects(
    () => unavailable('draft', 'shorter'),
    /temporarily unavailable/i,
  )

  const empty = createStatelessRewriter({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '' } }] } },
    }),
  })
  await assert.rejects(() => empty('draft', 'shorter'), /empty rewrite/i)
})
