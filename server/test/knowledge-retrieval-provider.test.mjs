import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
  assertKnowledgeRetrievalProvider,
  describeKnowledgeRetrievalProvider,
  knowledgeProviderHealth,
  normalizeKnowledgeProviderHealth,
  normalizeKnowledgeRetrievalResponse,
} from '../src/frontend/knowledge/retrieval-provider.mjs'

function provider(overrides = {}) {
  return {
    describe: () => ({
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'custom-rag',
      label: 'Custom RAG',
      capabilities: { filters: true, 'bad key': true, scores: false },
    }),
    retrieve: async () => ({ results: [] }),
    ...overrides,
  }
}

test('validates the minimal versioned retrieval provider contract', () => {
  assert.throws(
    () => assertKnowledgeRetrievalProvider({ describe: () => ({}) }),
    /retrieve/,
  )
  assert.throws(
    () => assertKnowledgeRetrievalProvider(provider({
      describe: () => ({ protocolVersion: 2, key: 'future', label: 'Future' }),
    })),
    /protocol version/,
  )
  assert.throws(
    () => assertKnowledgeRetrievalProvider(provider({ health: true })),
    /health must be a function/,
  )
  const fixture = provider()
  assert.equal(assertKnowledgeRetrievalProvider(fixture), fixture)
  assert.deepEqual(describeKnowledgeRetrievalProvider(fixture), {
    protocolVersion: 1,
    key: 'custom-rag',
    label: 'Custom RAG',
    capabilities: { filters: true, scores: false },
  })
})

test('normalizes optional provider health without coupling to transport', async () => {
  assert.deepEqual(await knowledgeProviderHealth(provider()), {
    status: 'ready',
    ok: true,
  })
  assert.deepEqual(await knowledgeProviderHealth(provider({
    health: async () => ({ status: 'degraded', message: 'slow upstream' }),
  })), {
    status: 'degraded',
    ok: true,
    message: 'slow upstream',
  })
  assert.throws(
    () => normalizeKnowledgeProviderHealth({ status: 'starting' }),
    /invalid status/,
  )
})

test('bounds, deduplicates, and normalizes provider results and citations', () => {
  const normalized = normalizeKnowledgeRetrievalResponse({
    results: [
      {
        id: 'result_one',
        content: 'A'.repeat(40),
        score: '0.85',
        source: {
          id: 'doc_one',
          title: ' One  title ',
          uri: 'https://example.com/guide#section',
          mimeType: 'text/markdown',
          locator: 'page=3',
        },
        metadata: {
          category: 'guide',
          nested: { rejected: true },
          rank: 2,
        },
      },
      { id: 'result_one', content: 'duplicate' },
      { id: 'missing-content' },
      {
        id: 'private-source',
        content: 'Private fact',
        source: { uri: 'file:///private/document.txt' },
      },
    ],
  }, {
    query: '  question  ',
    limit: 3,
    maxContentChars: 12,
  })

  assert.equal(normalized.status, 'ok')
  assert.equal(normalized.query, 'question')
  assert.equal(normalized.results.length, 2)
  assert.deepEqual(normalized.results[0], {
    id: 'result_one',
    content: 'A'.repeat(12),
    score: 0.85,
    source: {
      id: 'doc_one',
      title: 'One title',
      uri: 'https://example.com/guide',
      mime_type: 'text/markdown',
      locator: 'page=3',
    },
    metadata: { category: 'guide', rank: 2 },
    url: 'https://example.com/guide',
    citation_id: 'source_1',
  })
  assert.equal(normalized.citations.length, 1)
  assert.equal(normalized.results[1].source, undefined)
  assert.equal(normalized.results[1].citation_id, undefined)
  assert.match(normalized.notice, /不可信/)
})
