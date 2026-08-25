import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { FileKnowledgeStore } from '../src/providers/knowledge/file-knowledge-store.mjs'
import {
  LexicalKnowledgeRetrievalProvider,
} from '../src/providers/knowledge/lexical-retrieval-provider.mjs'

function fixture() {
  const store = new FileKnowledgeStore({
    directory: mkdtempSync(resolve(tmpdir(), 'qwaudio-lexical-')),
  })
  const put = (ownerId, id, title, text) => store.putDocument(ownerId, {
    id,
    title,
    mimeType: 'text/markdown',
    revision: `revision-${id}`,
    source: { kind: 'test', label: title },
    chunks: [{ text }],
  })
  return { store, provider: new LexicalKnowledgeRetrievalProvider({ store }), put }
}

test('retrieves bounded Chinese and English lexical matches for one owner', async () => {
  const { provider, put } = fixture()
  put('owner', 'doc_hangzhou', '杭州手册', '西湖附近的团队每周一上午开会。')
  put('owner', 'doc_release', 'Release guide', 'Run release check before publishing.')
  put('other', 'doc_private', '杭州私密信息', '不应跨用户检索。')

  const chinese = await provider.retrieve('杭州团队什么时候开会', {
    ownerId: 'owner',
    limit: 5,
  })
  assert.equal(chinese.results[0].documentId, 'doc_hangzhou')
  assert.equal(chinese.results.some(result => result.documentId === 'doc_private'), false)

  const english = await provider.retrieve('release publishing', {
    ownerId: 'owner',
    documentIds: ['doc_release'],
  })
  assert.deepEqual(english.results.map(result => result.documentId), ['doc_release'])
  assert.equal(english.results[0].score > 0, true)
})

test('returns no lexical matches for empty input and respects abort signals', async () => {
  const { provider } = fixture()
  assert.deepEqual(
    await provider.retrieve('', { ownerId: 'owner' }),
    { results: [] },
  )
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  await assert.rejects(
    provider.retrieve('anything', { ownerId: 'owner', signal: controller.signal }),
    /stopped/,
  )
})
