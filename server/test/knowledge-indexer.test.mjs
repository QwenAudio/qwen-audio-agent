import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { TextDocumentExtractor } from '../src/frontend/knowledge/document-extractor.mjs'
import { FileKnowledgeStore } from '../src/providers/knowledge/file-knowledge-store.mjs'
import {
  chunkDocumentSpans,
  chunkDocumentText,
  KnowledgeIndexer,
} from '../src/frontend/knowledge/knowledge-indexer.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskScope } from '../src/task/task-state.mjs'

function fixture() {
  const store = new FileKnowledgeStore({
    directory: mkdtempSync(resolve(tmpdir(), 'qwaudio-indexer-')),
  })
  const taskManager = new TaskManager()
  const indexer = new KnowledgeIndexer({
    extractor: new TextDocumentExtractor(),
    store,
    taskManager,
    chunkChars: 300,
    overlapChars: 30,
  })
  return { indexer, store, taskManager }
}

test('indexes documents through the invisible system-job pool', async () => {
  const { indexer, store, taskManager } = fixture()
  const userEvents = []
  taskManager.subscribe(event => userEvents.push(event))
  const source = {
    filename: 'guide.md',
    content: `# Guide\n\n${'A useful paragraph. '.repeat(50)}`,
    kind: 'upload',
  }

  const job = indexer.index({ ownerId: 'owner', sessionId: 'voice', source })
  const completed = await taskManager.wait(job.id)

  assert.equal(job.scope, TaskScope.SYSTEM)
  assert.equal(job.kind, 'knowledge_index')
  assert.equal(job.jobId, null)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.notificationStatus, 'none')
  assert.equal(userEvents.length, 0)
  const documents = await indexer.list('owner')
  assert.equal(documents.length, 1)
  assert.equal(documents[0].title, 'guide.md')
  assert.equal(documents[0].chunkCount > 1, true)
  const stored = store.getDocument('owner', documents[0].id)
  assert.equal(stored.source.kind, 'upload')
  assert.equal(Number.isInteger(stored.chunks[0].start), true)
  assert.equal(Number.isInteger(stored.chunks[0].end), true)
})

test('records source spans so overlapping chunks can reconstruct full context', () => {
  const text = `Header\n\n${'alpha beta gamma. '.repeat(80)}Footer`
  const chunks = chunkDocumentSpans(text, {
    chunkChars: 300,
    overlapChars: 30,
  })
  let reconstructed = ''
  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.start > cursor && reconstructed) reconstructed += '\n'
    reconstructed += chunk.text.slice(Math.max(0, cursor - chunk.start))
    cursor = Math.max(cursor, chunk.end)
  }
  assert.equal(reconstructed, text)
})

test('uses a stable document id and replaces a changed source revision', async () => {
  const { indexer, store, taskManager } = fixture()
  const first = indexer.index({
    ownerId: 'owner',
    source: { filename: 'same.md', content: 'First revision' },
  })
  await taskManager.wait(first.id)
  const original = store.listDocuments('owner')[0]

  const second = indexer.index({
    ownerId: 'owner',
    source: { filename: 'same.md', content: 'Second revision' },
  })
  await taskManager.wait(second.id)
  const replacement = store.listDocuments('owner')[0]

  assert.equal(replacement.id, original.id)
  assert.notEqual(replacement.revision, original.revision)
  assert.equal(replacement.createdAt, original.createdAt)
  assert.equal(store.getDocument('owner', replacement.id).chunks[0].text, 'Second revision')
})

test('chunks text with bounded overlap and rejects silent truncation', () => {
  const text = Array.from({ length: 2_500 }, (_, index) => String(index % 10)).join('')
  const chunks = chunkDocumentText(text, {
    chunkChars: 1_000,
    overlapChars: 100,
    maxChunks: 3,
  })

  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100))
  assert.throws(
    () => chunkDocumentText(text, {
      chunkChars: 500,
      overlapChars: 0,
      maxChunks: 2,
    }),
    error => error.code === 'document_chunk_limit_exceeded',
  )
})
