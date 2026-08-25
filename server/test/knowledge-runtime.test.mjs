import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { TextDocumentExtractor } from '../src/frontend/knowledge/document-extractor.mjs'
import { KnowledgeIndexer } from '../src/frontend/knowledge/knowledge-indexer.mjs'
import { FrontendKnowledgeRuntime } from '../src/frontend/knowledge/knowledge-runtime.mjs'
import { FileKnowledgeStore } from '../src/providers/knowledge/file-knowledge-store.mjs'
import {
  LexicalKnowledgeRetrievalProvider,
} from '../src/providers/knowledge/lexical-retrieval-provider.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

function fixture(runtimeOptions = {}) {
  const store = new FileKnowledgeStore({
    directory: mkdtempSync(resolve(tmpdir(), 'qwaudio-knowledge-runtime-')),
  })
  const taskManager = new TaskManager()
  const indexer = new KnowledgeIndexer({
    extractor: new TextDocumentExtractor(),
    store,
    taskManager,
    chunkChars: 300,
    overlapChars: 30,
  })
  const retrievalProvider = new LexicalKnowledgeRetrievalProvider({ store })
  const runtime = new FrontendKnowledgeRuntime({
    store,
    indexer,
    retrievalProvider,
    ...runtimeOptions,
  })
  return { runtime, store, taskManager }
}

test('indexes explicitly supplied sources and exposes search, list, and full context', async () => {
  const { runtime, taskManager } = fixture()
  const userEvents = []
  taskManager.subscribe(event => userEvents.push(event))
  const content = `# Project notes\n\n${'The launch checklist includes release check. '.repeat(24)}`

  const indexed = await runtime.index({
    ownerId: 'owner',
    sessionId: 'voice',
    sources: [{
      id: 'attachment:notes.md',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      content,
      kind: 'attachment',
    }],
  })

  assert.equal(indexed.failures.length, 0)
  assert.equal(indexed.documents.length, 1)
  assert.equal(userEvents.length, 0)
  const [summary] = await runtime.list('owner')
  assert.equal(summary.title, 'notes.md')
  const search = await runtime.search('launch release checklist', { ownerId: 'owner' })
  assert.equal(search.status, 'ok')
  assert.equal(search.results[0].document_id, summary.id)
  const full = await runtime.read('owner', summary.id)
  assert.equal(full.content, content.trim())
  assert.equal(await runtime.remove('owner', summary.id), true)
  assert.equal(await runtime.read('owner', summary.id), null)
})

test('deduplicates one explicit indexing batch by stable document revision', async () => {
  const { runtime } = fixture()
  const source = {
    id: 'attachment:same.md',
    filename: 'same.md',
    mimeType: 'text/markdown',
    content: 'One copy',
  }
  const indexed = await runtime.index({
    ownerId: 'owner',
    sessionId: 'voice',
    sources: [source, { ...source }],
  })
  assert.equal(indexed.documents.length, 1)
  assert.equal((await runtime.list('owner')).length, 1)
})

test('rejects full context above its byte boundary and directs callers to retrieval', async () => {
  const { runtime } = fixture({ maxFullContextBytes: 40 })
  const indexed = await runtime.index({
    ownerId: 'owner',
    sources: [{
      id: 'attachment:large.md',
      filename: 'large.md',
      mimeType: 'text/markdown',
      content: '知识内容'.repeat(20),
    }],
  })
  await assert.rejects(
    runtime.read('owner', indexed.documents[0].id),
    error => error.code === 'knowledge_full_context_too_large',
  )
})
