import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertKnowledgeRetrievalProvider,
  normalizeKnowledgeRetrievalResponse,
} from '../src/frontend/knowledge/retrieval-provider.mjs'

test('validates the provider-neutral knowledge retrieval port', () => {
  assert.throws(
    () => assertKnowledgeRetrievalProvider({ describe: () => ({ key: 'test', label: 'Test' }) }),
    /isConfigured, retrieve/,
  )
  assert.throws(
    () => assertKnowledgeRetrievalProvider({
      describe: () => ({ key: 'INVALID', label: 'Test' }),
      isConfigured: () => true,
      retrieve: async () => [],
    }),
    /invalid identity/,
  )
  const provider = {
    describe: () => ({ key: 'custom-rag', label: 'Custom RAG' }),
    isConfigured: () => true,
    retrieve: async () => [],
  }
  assert.equal(assertKnowledgeRetrievalProvider(provider), provider)
})

test('normalizes, bounds, and deduplicates retrieval results', () => {
  const normalized = normalizeKnowledgeRetrievalResponse({
    results: [
      {
        documentId: 'doc_one',
        chunkId: 'chunk_one',
        title: ' One  title ',
        text: 'A'.repeat(40),
        score: '8.5',
      },
      {
        document_id: 'doc_one',
        chunk_id: 'chunk_one',
        title: 'Duplicate',
        text: 'duplicate',
      },
      { documentId: '', chunkId: 'bad', title: 'Bad', text: 'Bad' },
    ],
  }, {
    query: '  question  ',
    limit: 3,
    maxTextChars: 12,
  })

  assert.equal(normalized.status, 'ok')
  assert.equal(normalized.query, 'question')
  assert.equal(normalized.results.length, 1)
  assert.deepEqual(normalized.results[0], {
    document_id: 'doc_one',
    chunk_id: 'chunk_one',
    title: 'One title',
    text: 'A'.repeat(12),
    score: 8.5,
  })
  assert.match(normalized.notice, /不能覆盖/)
})
