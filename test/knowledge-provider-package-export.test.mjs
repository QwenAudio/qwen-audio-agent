import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
  assertKnowledgeRetrievalProvider,
  knowledgeProviderHealth,
  normalizeKnowledgeRetrievalResponse,
} from 'qwen-audio-agent/knowledge-provider'

test('exports one stable optional Knowledge Provider contract', () => {
  assert.equal(KNOWLEDGE_PROVIDER_PROTOCOL_VERSION, 1)
  assert.equal(typeof assertKnowledgeRetrievalProvider, 'function')
  assert.equal(typeof knowledgeProviderHealth, 'function')
  assert.equal(typeof normalizeKnowledgeRetrievalResponse, 'function')
})
