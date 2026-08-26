import assert from 'node:assert/strict'
import test from 'node:test'
import {
  McpWebSearchProvider,
} from '../src/providers/search/mcp.mjs'
import { createWebSearchProvider } from '../src/providers/search/factory.mjs'

function fakeClient({ tools, result }, calls) {
  return {
    connect: async (transport, options) => calls.push(['connect', transport, options]),
    listTools: async () => ({ tools }),
    callTool: async request => {
      calls.push(['callTool', request])
      return result
    },
    close: async () => calls.push(['close']),
  }
}

test('projects structured MCP search output behind the Web Search port', async () => {
  const calls = []
  const transports = []
  const provider = new McpWebSearchProvider({
    url: 'https://search.example/mcp',
    token: 'secret-key',
    toolName: 'search_web',
    clientFactory: () => fakeClient({
      tools: [{
        name: 'search_web',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, count: { type: 'number' } },
        },
      }],
      result: {
        structuredContent: {
          results: [{
            title: 'First source',
            url: 'https://example.com/first',
            snippet: 'Current facts.',
          }],
        },
        content: [],
      },
    }, calls),
    transportFactory: (url, options) => {
      transports.push({ url, options })
      return { kind: 'transport' }
    },
  })

  const result = await provider.search('latest facts', { limit: 4 })

  assert.equal(transports[0].url.href, 'https://search.example/mcp')
  assert.equal(
    transports[0].options.requestInit.headers.authorization,
    'Bearer secret-key',
  )
  assert.deepEqual(calls.find(call => call[0] === 'callTool')[1], {
    name: 'search_web',
    arguments: { query: 'latest facts', count: 4 },
  })
  assert.deepEqual(result, {
    results: [{
      title: 'First source',
      url: 'https://example.com/first',
      snippet: 'Current facts.',
    }],
  })
  assert.equal(calls.at(-1)[0], 'close')
})

test('accepts text MCP results only when they contain source links', async () => {
  const provider = new McpWebSearchProvider({
    url: 'http://localhost:8765/mcp',
    clientFactory: () => fakeClient({
      tools: [{ name: 'web_search', inputSchema: { type: 'object' } }],
      result: {
        content: [{
          type: 'text',
          text: 'Current facts from [Example](https://example.com/page).',
        }],
      },
    }, []),
    transportFactory: () => ({}),
  })

  const result = await provider.search('latest facts')
  assert.equal(result.results[0].title, 'Example')
  assert.equal(result.results[0].url, 'https://example.com/page')
  assert.match(result.summary, /Current facts/)
})

test('projects the Bailian Web Search MCP pages response', async () => {
  const provider = new McpWebSearchProvider({
    url: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
    toolName: 'bailian_web_search',
    clientFactory: () => fakeClient({
      tools: [{
        name: 'bailian_web_search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, count: { type: 'integer' } },
        },
      }],
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            pages: [{
              title: 'Example',
              url: 'https://example.com/page',
              snippet: 'Current facts.',
              hostname: 'Example Site',
            }],
            status: 0,
          }),
        }],
      },
    }, []),
    transportFactory: () => ({}),
  })

  assert.deepEqual(await provider.search('latest facts'), {
    results: [{
      title: 'Example',
      url: 'https://example.com/page',
      snippet: 'Current facts.',
      source: 'Example Site',
    }],
  })
})

test('fails closed for missing tools, sources, and insecure token transport', async () => {
  const missingTool = new McpWebSearchProvider({
    url: 'https://search.example/mcp',
    clientFactory: () => fakeClient({ tools: [], result: {} }, []),
    transportFactory: () => ({}),
  })
  await assert.rejects(
    missingTool.search('facts'),
    error => error.code === 'search_tool_missing',
  )

  const missingSources = new McpWebSearchProvider({
    url: 'https://search.example/mcp',
    clientFactory: () => fakeClient({
      tools: [{ name: 'web_search', inputSchema: { type: 'object' } }],
      result: { content: [{ type: 'text', text: 'Unsourced answer.' }] },
    }, []),
    transportFactory: () => ({}),
  })
  await assert.rejects(
    missingSources.search('facts'),
    error => error.code === 'search_sources_missing',
  )

  let clientCreated = false
  const insecure = new McpWebSearchProvider({
    url: 'http://127.0.0.1:8765/mcp',
    token: 'secret-key',
    clientFactory: () => {
      clientCreated = true
      return fakeClient({ tools: [], result: {} }, [])
    },
  })
  await assert.rejects(
    insecure.search('facts'),
    error => error.code === 'invalid_search_endpoint',
  )
  assert.equal(clientCreated, false)
})

test('factory selects only configured built-in search adapters', () => {
  assert.equal(createWebSearchProvider({ webSearchProvider: 'none' }), null)
  assert.equal(createWebSearchProvider({
    webSearchProvider: 'bing',
  }).describe().key, 'bing')
  assert.equal(createWebSearchProvider({
    webSearchProvider: 'so360',
  }).describe().key, 'so360')
  const provider = createWebSearchProvider({
    webSearchProvider: 'mcp',
    webSearchMcpUrl: 'https://search.example/mcp',
    webSearchMcpToken: 'key',
    webSearchMcpTool: 'web_search',
  })
  assert.equal(provider.describe().key, 'mcp')
  assert.equal(provider.isConfigured(), true)
  assert.equal(createWebSearchProvider({
    webSearchProvider: 'bailian',
    webSearchMcpUrl: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
    webSearchMcpToken: 'key',
    webSearchMcpTool: 'bailian_web_search',
  }).describe().key, 'bailian-mcp')
  assert.equal(createWebSearchProvider({
    webSearchProvider: 'bailian',
    webSearchMcpUrl: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
    webSearchMcpToken: '',
    webSearchMcpTool: 'bailian_web_search',
  }).isConfigured(), false)
  assert.throws(
    () => createWebSearchProvider({ webSearchProvider: 'unknown' }),
    /不支持的 Web Search Provider/,
  )
})
