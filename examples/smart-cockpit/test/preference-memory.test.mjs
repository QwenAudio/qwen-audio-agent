import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildMemoryContext } from '../../../server/src/memory/context.mjs'
import { MarkdownContextStore } from '../../../server/src/memory/providers/markdown/context-store.mjs'
import { MarkdownMemoryProvider } from '../../../server/src/memory/providers/markdown/provider.mjs'
import { FrontendMemoryRuntime } from '../../../server/src/memory/runtime.mjs'
import { memoryToolHandlers } from '../../../server/src/memory/tools.mjs'

const ownerId = 'cockpit-driver'
const preference = '- 用户喜欢吃烧烤，不太能吃辣。'

function memoryServiceAt(root) {
  const store = (scope, filename) => new MarkdownContextStore({
    filePath: join(root, filename),
    scope,
    personalOwnerId: ownerId,
  })
  return new FrontendMemoryRuntime({
    provider: new MarkdownMemoryProvider({
      userStore: store('user', 'USER.md'),
      memoryStore: store('memory', 'MEMORY.md'),
    }),
  })
}

function session(memoryService, sessionId, sessionOwnerId = ownerId) {
  const outputs = []
  let changed = 0
  const handlers = memoryToolHandlers({
    memoryService,
    ownerId: sessionOwnerId,
    sessionId,
    beginDeferredToolResponse: () => null,
    completeDeferredToolResponse: async () => {},
    onMemoryChanged: () => { changed += 1 },
    sendOutput: async (_callId, output) => { outputs.push(output) },
  })
  return {
    recentMessages: [],
    get changed() { return changed },
    async memory(args) {
      await handlers.memory({
        callId: `${sessionId}-memory-${outputs.length}`,
        turnId: `${sessionId}-turn`,
        generation: 1,
        args,
        event: {},
        callContext: {},
      })
      return outputs.at(-1)
    },
    context() {
      return buildMemoryContext({ memories: memoryService.list(sessionOwnerId) })
    },
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qwen-cockpit-preference-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// This supplies the memory tool call explicitly. Whether a live model extracts
// "我爱吃烧烤" and calls memory by itself is a separate live acceptance check.
test('an existing memory tool write survives provider reconstruction and reaches a fresh same-owner context', async t => {
  const root = await fixture(t)
  const firstService = memoryServiceAt(root)
  const first = session(firstService, 'drive-one')
  const written = await first.memory({ action: 'append', document: 'memory', content: preference })
  assert.equal(written.status, 'updated')
  assert.equal(first.changed, 1)
  assert.match(await readFile(join(root, 'MEMORY.md'), 'utf8'), /用户喜欢吃烧烤/u)
  assert.match(await readFile(join(root, 'MEMORY.md'), 'utf8'), /不太能吃辣/u)
  await firstService.close()

  const restoredService = memoryServiceAt(root)
  t.after(() => restoredService.close())
  const fresh = session(restoredService, 'drive-two')
  assert.deepEqual(fresh.recentMessages, [])
  assert.match(fresh.context(), /<user_memory[^>]*>[\s\S]*用户喜欢吃烧烤/u)
  assert.match(fresh.context(), /不太能吃辣/u)
  const recalled = await fresh.memory({ action: 'read', document: 'memory', query: '用户喜欢吃什么？' })
  assert.equal(recalled.status, 'ok')
  assert.match(recalled.documents[0].content, /用户喜欢吃烧烤/u)
  assert.match(recalled.documents[0].content, /不太能吃辣/u)

  const otherDriver = session(restoredService, 'drive-three', 'another-driver')
  assert.doesNotMatch(otherDriver.context(), /烧烤/u)
  const isolated = await otherDriver.memory({ action: 'read', document: 'memory' })
  assert.equal(isolated.status, 'not_found')
  assert.deepEqual(isolated.documents, [])
})

test('deleting a persisted preference through the existing memory tool removes it from later fresh contexts', async t => {
  const root = await fixture(t)
  const firstService = memoryServiceAt(root)
  const first = session(firstService, 'drive-one')
  await first.memory({ action: 'append', document: 'memory', content: preference })
  const removed = await first.memory({
    action: 'replace',
    document: 'memory',
    old_text: preference,
    new_text: '',
  })
  assert.equal(removed.status, 'updated')
  assert.equal(first.changed, 2)
  await firstService.close()

  const restoredService = memoryServiceAt(root)
  t.after(() => restoredService.close())
  const fresh = session(restoredService, 'drive-two')
  assert.deepEqual(fresh.recentMessages, [])
  assert.doesNotMatch(fresh.context(), /烧烤/u)
  assert.doesNotMatch(await readFile(join(root, 'MEMORY.md'), 'utf8'), /烧烤/u)
})
