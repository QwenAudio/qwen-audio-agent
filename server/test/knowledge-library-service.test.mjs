import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeLibraryService } from '../src/app/knowledge/knowledge-library-service.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

function provider(overrides = {}) {
  return {
    describe: () => ({
      protocolVersion: 1,
      key: 'fixture',
      label: 'Fixture',
      capabilities: {},
    }),
    retrieve: async () => ({ results: [] }),
    ingest: async ({ source }) => ({
      document: { id: 'doc-one', title: source.name },
    }),
    list: async () => ({ documents: [{ id: 'doc-one', title: 'Manual' }] }),
    remove: async ({ documentId }) => ({
      removed: documentId === 'doc-one',
      document: { id: documentId },
    }),
    ...overrides,
  }
}

test('runs ingestion as a silent knowledge job and forwards trusted context', async () => {
  let received
  const manager = new TaskManager()
  const service = new KnowledgeLibraryService({
    taskManager: manager,
    provider: provider({
      async ingest(request, context) {
        received = { request, context }
        return { document: { id: 'doc-one', title: 'Manual' } }
      },
    }),
  })
  const { task } = service.startIngestion({
    ownerId: 'owner-one',
    sourcePath: '/docs/manual.pdf',
  })
  await manager.wait(task.id)

  assert.equal(manager.get(task.id).kind, 'knowledge_ingestion')
  assert.equal(manager.get(task.id).notificationPolicy, 'silent')
  assert.equal(received.request.source.path, '/docs/manual.pdf')
  assert.equal(received.context.ownerId, 'owner-one')
  assert.equal(received.context.taskId, task.id)
  assert.equal(received.context.signal instanceof AbortSignal, true)
})

test('maps list and remove through the configured provider', async () => {
  const service = new KnowledgeLibraryService({
    taskManager: new TaskManager(),
    provider: provider(),
  })
  assert.deepEqual(await service.list({ ownerId: 'owner-one' }), [
    { id: 'doc-one', title: 'Manual' },
  ])
  assert.equal((await service.remove({
    ownerId: 'owner-one',
    documentId: 'doc-one',
  })).removed, true)
})
