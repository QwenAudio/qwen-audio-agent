import assert from 'node:assert/strict'
import test from 'node:test'
import {
  roundRobinMerge,
  normalizeSearchResponse,
} from '../src/core/citation.mjs'
import {
  FrontendRetrievalRuntime,
} from '../src/frontend/retrieval/frontend-retrieval-runtime.mjs'
import {
  retrievalToolHandlers,
  WEB_SEARCH_TOOL_NAME,
} from '../src/frontend/tools/features/retrieval-tools.mjs'

test('roundRobinMerge interleaves results rank by rank across queries', () => {
  const q1Results = [
    { title: 'A0', url: 'https://example.com/a0', snippet: 'snippet A0' },
    { title: 'A1', url: 'https://example.com/a1', snippet: 'snippet A1' },
    { title: 'A2', url: 'https://example.com/a2', snippet: 'snippet A2' },
  ]
  const q2Results = [
    { title: 'B0', url: 'https://example.com/b0', snippet: 'snippet B0' },
    { title: 'B1', url: 'https://example.com/b1', snippet: 'snippet B1' },
  ]

  const merged = roundRobinMerge([
    ['query A', q1Results],
    ['query B', q2Results],
  ], { maxResults: 5 })

  assert.equal(merged.length, 5)
  assert.deepEqual(merged.map(item => item.title), ['A0', 'B0', 'A1', 'B1', 'A2'])
  assert.equal(merged[0].from_query, 'query A')
  assert.equal(merged[1].from_query, 'query B')
})

test('roundRobinMerge deduplicates URLs globally and preserves first occurrence', () => {
  const q1Results = [
    { title: 'A0', url: 'https://example.com/shared', snippet: 'first match' },
    { title: 'A1', url: 'https://example.com/a1', snippet: 'a1' },
  ]
  const q2Results = [
    { title: 'B0-dup', url: 'https://example.com/shared', snippet: 'duplicate' },
    { title: 'B1', url: 'https://example.com/b1', snippet: 'b1' },
  ]

  const merged = roundRobinMerge([
    ['query 1', q1Results],
    ['query 2', q2Results],
  ], { maxResults: 4 })

  assert.equal(merged.length, 3)
  assert.deepEqual(merged.map(item => item.url), [
    'https://example.com/shared',
    'https://example.com/a1',
    'https://example.com/b1',
  ])
  assert.equal(merged[0].snippet, 'first match')
  assert.equal(merged[0].from_query, 'query 1')
})

test('roundRobinMerge respects maxResults limit', () => {
  const q1Results = [
    { title: 'A0', url: 'https://example.com/a0' },
    { title: 'A1', url: 'https://example.com/a1' },
  ]
  const q2Results = [
    { title: 'B0', url: 'https://example.com/b0' },
    { title: 'B1', url: 'https://example.com/b1' },
  ]

  const merged = roundRobinMerge([
    ['q1', q1Results],
    ['q2', q2Results],
  ], { maxResults: 2 })

  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map(item => item.title), ['A0', 'B0'])
})

test('normalizeSearchResponse preserves from_query attribution on results', () => {
  const mergedItems = [
    { title: 'A0', url: 'https://example.com/a0', snippet: 's0', from_query: 'query A' },
    { title: 'B0', url: 'https://example.com/b0', snippet: 's1', from_query: 'query B' },
  ]

  const response = normalizeSearchResponse(mergedItems, {
    query: 'query A；query B',
    limit: 5,
  })

  assert.equal(response.results.length, 2)
  assert.equal(response.results[0].from_query, 'query A')
  assert.equal(response.results[1].from_query, 'query B')
  assert.equal(response.query, 'query A；query B')
})

test('FrontendRetrievalRuntime.search executes multi-query searches concurrently and merges results', async () => {
  const searches = []
  const mockProvider = {
    describe: () => ({ key: 'mock', label: 'Mock', configured: true }),
    isConfigured: () => true,
    search: async (q, options) => {
      searches.push({ q, options })
      if (q === 'iphone 16') {
        return {
          results: [
            { title: 'iPhone 16 Review', url: 'https://example.com/ip16', snippet: 'great battery' },
            { title: 'iPhone 16 Specs', url: 'https://example.com/ip16-specs', snippet: 'specs' },
          ],
        }
      }
      if (q === 'xiaomi 15') {
        return {
          results: [
            { title: 'Xiaomi 15 Review', url: 'https://example.com/mi15', snippet: 'huge battery' },
            { title: 'Xiaomi 15 Specs', url: 'https://example.com/mi15-specs', snippet: 'specs' },
          ],
        }
      }
      return { results: [] }
    },
  }

  const runtime = new FrontendRetrievalRuntime({ searchProvider: mockProvider })
  const response = await runtime.search(['iphone 16', 'xiaomi 15'], { limit: 3 })

  assert.equal(searches.length, 2)
  assert.equal(response.results.length, 3)
  assert.equal(response.results[0].title, 'iPhone 16 Review')
  assert.equal(response.results[0].from_query, 'iphone 16')
  assert.equal(response.results[1].title, 'Xiaomi 15 Review')
  assert.equal(response.results[1].from_query, 'xiaomi 15')
  assert.equal(response.results[2].title, 'iPhone 16 Specs')
  assert.equal(response.results[2].from_query, 'iphone 16')
  assert.equal(response.query, 'iphone 16；xiaomi 15')
})

test('FrontendRetrievalRuntime.search gracefully handles partial query failures', async () => {
  const mockProvider = {
    describe: () => ({ key: 'mock', label: 'Mock', configured: true }),
    isConfigured: () => true,
    search: async q => {
      if (q === 'fail') throw new Error('network timeout')
      return {
        results: [
          { title: 'Success Result', url: 'https://example.com/ok', snippet: 'ok' },
        ],
      }
    },
  }

  const runtime = new FrontendRetrievalRuntime({ searchProvider: mockProvider })
  const response = await runtime.search(['fail', 'succeed'], { limit: 5 })

  assert.equal(response.results.length, 1)
  assert.equal(response.results[0].title, 'Success Result')
  assert.equal(response.results[0].from_query, 'succeed')
})

test('FrontendRetrievalRuntime.search propagates error if all queries fail', async () => {
  const mockProvider = {
    describe: () => ({ key: 'mock', label: 'Mock', configured: true }),
    isConfigured: () => true,
    search: async () => {
      throw new Error('search engine unavailable')
    },
  }

  const runtime = new FrontendRetrievalRuntime({ searchProvider: mockProvider })
  await assert.rejects(
    async () => runtime.search(['q1', 'q2'], { limit: 5 }),
    /search engine unavailable/,
  )
})

test('retrieval-tools webSearch passes queries array to frontendRetrieval.search', async () => {
  let capturedTarget = null
  let capturedOptions = null
  const outputs = []

  const mockRuntime = {
    frontendRetrieval: {
      search: async (target, options) => {
        capturedTarget = target
        capturedOptions = options
        return { status: 'ok', results: [] }
      },
    },
    sendOutput: async (callId, result, turnId) => {
      outputs.push({ callId, result, turnId })
    },
  }

  const handlers = retrievalToolHandlers(mockRuntime)
  await handlers[WEB_SEARCH_TOOL_NAME]({
    callId: 'call-1',
    turnId: 'turn-1',
    args: { queries: ['topic A', 'topic B'], limit: 4 },
  })

  assert.deepEqual(capturedTarget, ['topic A', 'topic B'])
  assert.equal(capturedOptions.limit, 4)
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].result.status, 'ok')
})

test('retrieval-tools webSearch supports backward-compatible single query and missing query failure', async () => {
  let capturedTarget = null
  const outputs = []

  const mockRuntime = {
    frontendRetrieval: {
      search: async target => {
        capturedTarget = target
        return { status: 'ok', results: [] }
      },
    },
    sendOutput: async (callId, result, turnId) => {
      outputs.push({ callId, result, turnId })
    },
  }

  const handlers = retrievalToolHandlers(mockRuntime)

  // Single query backward compatibility
  await handlers[WEB_SEARCH_TOOL_NAME]({
    callId: 'call-1',
    turnId: 'turn-1',
    args: { query: 'single topic' },
  })
  assert.equal(capturedTarget, 'single topic')

  // Prioritize queries over query if both provided
  await handlers[WEB_SEARCH_TOOL_NAME]({
    callId: 'call-2',
    turnId: 'turn-2',
    args: { query: 'summary query', queries: ['sub 1', 'sub 2'] },
  })
  assert.deepEqual(capturedTarget, ['sub 1', 'sub 2'])

  // Missing query returns error
  await handlers[WEB_SEARCH_TOOL_NAME]({
    callId: 'call-3',
    turnId: 'turn-3',
    args: {},
  })
  assert.equal(outputs[2].result.error_code, 'missing_query')
})
