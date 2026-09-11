import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitAgentTools } from '../tools.mjs'

const cockpit = {
  list: async () => [{ name: 'flashbuy', inputSchema: { type: 'object' } }],
  call: async (name, args) => ({ content: name, data: args }),
}

test('composes web research with the existing MCP tool surface and timestamps evidence', async () => {
  const calls = []
  const tools = new CockpitAgentTools({
    cockpit,
    now: () => new Date('2026-09-11T00:00:00.000Z'),
    retrieval: {
      capabilities: () => ['web-search', 'url-fetch'],
      search: async (...args) => { calls.push(args); return { status: 'ok', citations: [{ url: 'https://example.com/' }] } },
      fetchUrl: async () => ({ status: 'ok', content: 'Page body', citations: [{ url: 'https://example.com/' }] }),
    },
  })
  assert.deepEqual((await tools.list()).map(tool => tool.name), ['flashbuy', 'web_search', 'fetch_url'])
  const controller = new AbortController()
  const result = await tools.call('web_search', { query: 'news', limit: 5 }, { signal: controller.signal })
  assert.equal(calls[0][1].signal, controller.signal)
  assert.equal(result.data.retrieval.retrieved_at, '2026-09-11T00:00:00.000Z')
  assert.deepEqual(JSON.parse(result.content), result.data)
  assert.equal((await tools.call('fetch_url', { url: 'https://example.com/' })).data.content, 'Page body')
  assert.equal((await tools.call('flashbuy', { action: 'search' })).data.action, 'search')
})

test('reports retrieval failure without exposing provider errors or inventing sources', async () => {
  const tools = new CockpitAgentTools({ cockpit, retrieval: {
    capabilities: () => ['web-search'],
    search: async () => { throw new Error('provider secret detail') },
  } })
  assert.deepEqual((await tools.list()).map(tool => tool.name), ['flashbuy', 'web_search'])
  const result = await tools.call('web_search', { query: 'news' })
  assert.equal(result.data.status, 'error')
  assert.deepEqual(result.data.citations, [])
  assert.doesNotMatch(result.content, /secret/)
  await assert.rejects(tools.call('fetch_url', { url: 'https://example.com/' }), /unavailable/)
})

test('does not turn cancellation into a successful tool failure receipt', async () => {
  const controller = new AbortController()
  const tools = new CockpitAgentTools({ cockpit, retrieval: {
    capabilities: () => ['web-search'],
    search: async () => { controller.abort(); throw new Error('aborted') },
  } })
  await assert.rejects(tools.call('web_search', { query: 'news' }, { signal: controller.signal }), error => error.name === 'AbortError')
})

test('bounds webpage context without losing citation metadata', async () => {
  const tools = new CockpitAgentTools({ cockpit, retrieval: {
    capabilities: () => ['url-fetch'],
    fetchUrl: async () => ({ status: 'ok', content: 'a'.repeat(20_000), citations: [{ url: 'https://example.com/' }] }),
  } })
  const result = await tools.call('fetch_url', { url: 'https://example.com/' })
  assert.equal(result.data.content.length, 16_000)
  assert.equal(result.data.truncated, true)
  assert.equal(result.data.citations.length, 1)
})
