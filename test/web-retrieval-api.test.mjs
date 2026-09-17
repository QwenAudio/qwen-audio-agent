import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebRetrieval } from 'qwen-audio-agent/web-retrieval'
import { resolveWebSearchConfiguration } from '../shared/web-search-configuration.mjs'

test('public retrieval factory shares the default provider without starting Gateway state', () => {
  const runtime = createWebRetrieval({ env: {} })
  assert.deepEqual(runtime.capabilities(), ['web-search', 'url-fetch'])
  assert.equal(runtime.describe().searchProvider.key, 'so360')
  assert.deepEqual(createWebRetrieval({ env: { QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'none' }, urlFetcher: null }).capabilities(), [])
})

test('pure search configuration preserves existing provider and credential selection', () => {
  assert.equal(resolveWebSearchConfiguration({}).provider, 'so360')
  const preset = resolveWebSearchConfiguration({ QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'bailian', DASHSCOPE_API_KEY: 'test-only-key' })
  assert.equal(preset.mcpToken, 'test-only-key')
  assert.equal(preset.mcpTool, 'bailian_web_search')
  const custom = resolveWebSearchConfiguration({ QWEN_AUDIO_WEB_SEARCH_MCP_URL: 'https://example.com/mcp', DASHSCOPE_API_KEY: 'test-only-key' })
  assert.equal(custom.provider, 'mcp')
  assert.equal(custom.mcpToken, '')
  assert.throws(() => resolveWebSearchConfiguration({ QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'unknown' }), /不支持/)
})

test('public retrieval uses existing normalization and cancellation contracts', async () => {
  const controller = new AbortController()
  let providerSignal
  const runtime = createWebRetrieval({
    env: {},
    searchProvider: {
      describe: () => ({ key: 'mock', label: 'Mock' }),
      isConfigured: () => true,
      search: async (_query, { limit, signal }) => {
        providerSignal = signal
        assert.equal(limit, 8)
        return { results: [{ title: 'Original release', url: 'https://example.com/news#title', publishedAt: '2026-09-11', snippet: 'Verified fixture' }] }
      },
    },
    urlFetcher: null,
  })
  const result = await runtime.search('latest releases', { limit: 99, signal: controller.signal })
  assert.equal(result.citations[0].url, 'https://example.com/news')
  assert.equal(result.citations[0].published_at, '2026-09-11')
  assert.match(result.notice, /不可信/)
  controller.abort()
  assert.equal(providerSignal.aborted, true)
})

test('public URL retrieval retains private-network, protocol and credential protections', async () => {
  const runtime = createWebRetrieval({ env: { QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'none' } })
  for (const [url, code] of [
    ['http://127.0.0.1/private', 'private_network_forbidden'],
    ['http://[::ffff:127.0.0.1]/private', 'private_network_forbidden'],
    ['file:///etc/passwd', 'unsupported_protocol'],
    ['https://user:password@example.com/', 'url_credentials_forbidden'],
  ]) {
    await assert.rejects(runtime.fetchUrl(url), error => error.code === code)
  }
})
