import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
  assertKnowledgeProvider,
  assertKnowledgeRetrievalProvider,
  knowledgeProviderHealth,
  normalizeKnowledgeRetrievalResponse,
  supportsKnowledgeManagement,
} from 'qwen-audio-agent/knowledge-provider'

test('exports one stable optional Knowledge Provider contract', () => {
  assert.equal(KNOWLEDGE_PROVIDER_PROTOCOL_VERSION, 1)
  assert.equal(typeof assertKnowledgeRetrievalProvider, 'function')
  assert.equal(typeof assertKnowledgeProvider, 'function')
  assert.equal(typeof supportsKnowledgeManagement, 'function')
  assert.equal(typeof knowledgeProviderHealth, 'function')
  assert.equal(typeof normalizeKnowledgeRetrievalResponse, 'function')
})
