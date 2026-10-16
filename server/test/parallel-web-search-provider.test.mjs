import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resolveWebSearchConfiguration } from '../../shared/web-search-configuration.mjs'
import { PACKAGE_VERSION } from '../src/core/package-version.mjs'
import { createWebSearchProvider } from '../src/frontend/retrieval/providers/factory.mjs'
import { FrontendRetrievalRuntime } from '../src/frontend/retrieval/frontend-retrieval-runtime.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'

const endpoint = 'https://search.parallel.ai/mcp'
const query = 'current Node.js release notes'
const result = {
  content: [{ type: 'text', text: JSON.stringify({ results: [
    { title: 'Release notes', url: 'https://nodejs.org/en/blog#release', publish_date: '2026-09-01', excerpts: ['Current release facts.', 'More details.'] },
    { title: 'Second source', url: 'https://example.com/notes', excerpts: ['Other facts.'] },
  ] }) }],
}

function harness({ env = {}, callResult = result, callStatus = 200, hang = false, searchTimeoutMs = 1000, disabledTools = [] } = {}) {
  const requests = []
  const outputs = []
  let started
  const searching = new Promise(resolve => { started = resolve })
  const config = resolveWebSearchConfiguration({ QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'parallel', ...env })
  const provider = createWebSearchProvider({
    webSearchProvider: config.provider,
    webSearchMcpUrl: config.mcpUrl,
    webSearchMcpToken: config.mcpToken,
    webSearchMcpTool: config.mcpTool,
  }, {
    // Exercise the real MCP client and HTTP transport, replacing only the wire.
    transportFactory: (url, options) => new StreamableHTTPClientTransport(url, {
      ...options,
      fetch: async (input, init) => {
        const body = init.body ? JSON.parse(init.body) : null
        requests.push({ url: String(input), headers: new Headers(init.headers), body, signal: init.signal })
        if (init.method === 'GET') return new Response(null, { status: 405 })
        if (!body?.id && body?.id !== 0) return new Response(null, { status: 202 })
        let response
        if (body.method === 'initialize') {
          response = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'search-fixture', version: '1' } }
        } else if (body.method === 'tools/list') {
          response = { tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: { objective: { type: 'string' }, search_queries: { type: 'array', items: { type: 'string' } } }, required: ['objective', 'search_queries'] } }] }
        } else if (body.method === 'tools/call') {
          started()
          if (hang) {
            return new Promise((resolve, reject) => {
              if (init.signal.aborted) reject(init.signal.reason)
              else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
            })
          }
          if (callStatus !== 200) return new Response('Rate limit exceeded', { status: callStatus, headers: { 'retry-after': '60' } })
          response = callResult
        } else throw new Error(`Unexpected MCP method: ${body.method}`)
        return Response.json({ jsonrpc: '2.0', id: body.id, result: response })
      },
    }),
  })
  const runtime = new FrontendRetrievalRuntime({ searchProvider: provider, urlFetcher: null, searchTimeoutMs })
  const handler = new ToolCallHandler({
    ownerId: 'test-owner', sessionId: 'test-session',
    getTurnId: () => 'turn', getTurnGeneration: () => 1,
    getFrontend: () => ({ sendFunctionOutput: async (...args) => outputs.push(args), ensureResponse: async () => {} }),
    frontendRetrieval: runtime, disabledTools,
  })
  const dispatch = (args = { query, limit: 1 }) => handler.handle({ name: 'web_search', call_id: 'search', arguments: JSON.stringify(args) })
  return { requests, outputs, runtime, dispatch, searching }
}

test('Parallel selection dispatches one anonymous search and delivers bounded cited excerpts to the voice frontend', async () => {
  const kit = harness({ env: {
    DASHSCOPE_API_KEY: 'unrelated-key',
    QWEN_AUDIO_WEB_SEARCH_MCP_URL: 'https://other.example/mcp',
    QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN: 'other-service-secret',
    QWEN_AUDIO_WEB_SEARCH_MCP_TOOL: 'other_tool',
  } })
  await kit.dispatch()
  assert.equal(kit.runtime.describe().searchProvider.key, 'parallel')
  for (const request of kit.requests) {
    assert.equal(request.url, endpoint)
    assert.equal(request.headers.get('user-agent'), `qwen-audio-agent/${PACKAGE_VERSION}`)
    assert.equal(request.headers.has('authorization'), false)
  }
  const calls = kit.requests.filter(request => request.body?.method === 'tools/call')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body.params, { name: 'web_search', arguments: { objective: query, search_queries: [query] } })
  const output = kit.outputs[0][1]
  assert.equal(output.status, 'ok')
  assert.equal(output.results.length, 1)
  assert.equal(output.results[0].snippet, 'Current release facts. More details.')
  assert.equal(output.results[0].citation_id, 'source_1')
  assert.equal(output.citations[0].url, 'https://nodejs.org/en/blog')
  assert.equal(output.citations[0].published_at, '2026-09-01')
  assert.match(output.notice, /不可信/)
})

test('text JSON larger than the excerpt budget still yields bounded useful source snippets', async () => {
  const kit = harness({ callResult: { content: [{ type: 'text', text: JSON.stringify({ results: [
    { title: 'Long source', url: 'https://example.com/long', excerpts: ['x'.repeat(25000)] },
  ] }) }] } })
  await kit.dispatch()
  assert.equal(kit.outputs[0][1].results[0].title, 'Long source')
  assert.equal(kit.outputs[0][1].results[0].snippet.length, 1200)
})

test('disabled search and hidden web tools make no HTTP request', async () => {
  for (const options of [{ env: { QWEN_AUDIO_WEB_SEARCH_PROVIDER: 'none' } }, { disabledTools: ['web_search', 'fetch_url'] }]) {
    const kit = harness(options)
    await kit.dispatch()
    assert.equal(kit.requests.length, 0)
    assert.equal(kit.outputs[0][1].error_code, 'tool_unavailable')
  }
})

test('HTTP rate limits, MCP tool errors and missing sources surface through the caller without fallback', async () => {
  for (const [options, code] of [
    [{ callStatus: 429 }, 'search_request_failed'],
    [{ callResult: { isError: true, content: [{ type: 'text', text: 'Anonymous quota exceeded' }] } }, 'search_tool_failed'],
    [{ callResult: { content: [{ type: 'text', text: 'No sources' }] } }, 'search_sources_missing'],
  ]) {
    const kit = harness(options)
    await kit.dispatch()
    assert.equal(kit.outputs[0][1].error_code, code)
    assert.equal(kit.outputs[0][1].retryable, true)
    assert.ok(kit.requests.every(request => request.url === endpoint))
    assert.equal(kit.requests.filter(request => request.body?.method === 'tools/call').length, 1)
  }
})

test('runtime timeout aborts the MCP request and returns a retryable frontend failure', async () => {
  const kit = harness({ hang: true, searchTimeoutMs: 30 })
  // AbortSignal.timeout does not keep the event loop alive in the fake wire.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await kit.dispatch()
    assert.equal(kit.outputs[0][1].error_code, 'search_aborted')
    assert.equal(kit.outputs[0][1].retryable, true)
    assert.equal(kit.requests.find(request => request.body?.method === 'tools/call').signal.aborted, true)
  } finally { clearInterval(keepAlive) }
})

test('caller cancellation aborts the selected MCP request', async () => {
  const kit = harness({ hang: true })
  const controller = new AbortController()
  const pending = kit.runtime.search(query, { signal: controller.signal })
  await kit.searching
  controller.abort()
  await assert.rejects(pending, error => error.code === 'search_aborted')
  assert.equal(kit.requests.find(request => request.body?.method === 'tools/call').signal.aborted, true)
})
