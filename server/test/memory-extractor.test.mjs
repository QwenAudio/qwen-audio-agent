import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { FrontendMemoryStore } from '../src/conversation/frontend-memory.mjs'
import {
  MemoryExtractor,
  createExtractorLlmCall,
} from '../src/conversation/memory-extractor.mjs'

const OWNER = 'owner'
const SESSION = 'main'

function chattySession(turns = 4) {
  const sync = new ConversationSync()
  for (let index = 0; index < turns; index += 1) {
    sync.record({
      ownerId: OWNER,
      sessionId: SESSION,
      id: `user-${index}`,
      role: 'user',
      content: `我最近每天早上都去跑步，第 ${index} 天了`,
      source: 'voice-user',
    })
    sync.record({
      ownerId: OWNER,
      sessionId: SESSION,
      id: `assistant-${index}`,
      role: 'assistant',
      content: '坚持得不错',
      source: 'realtime-direct',
    })
  }
  return sync
}

function extractor({
  llmCall,
  turns = 4,
  audit = null,
  now = () => 1_000_000,
} = {}) {
  const memoryStore = new FrontendMemoryStore({ now })
  const instance = new MemoryExtractor({
    memoryStore,
    conversationSync: chattySession(turns),
    audit,
    llmCall,
    logger: { warn: () => {}, debug: () => {} },
    now,
  })
  return { instance, memoryStore }
}

function opsResponse(ops) {
  return async () => JSON.stringify({ ops })
}

test('writes stated facts as inferred long-term memories', async () => {
  const { instance, memoryStore } = extractor({
    llmCall: opsResponse([
      { action: 'add', kind: 'stated', content: '用户每天早上跑步' },
    ]),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })

  const memories = memoryStore.list(OWNER)
  assert.equal(memories.length, 1)
  assert.equal(memories[0].content, '用户每天早上跑步')
  assert.equal(memories[0].scope, 'facts')
  assert.equal(memories[0].source, 'inferred')
})

test('skips inferred candidates, duplicates and sensitive content', async () => {
  const events = []
  const { instance, memoryStore } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: opsResponse([
      { action: 'add', kind: 'inferred', content: '用户可能在准备搬家' },
      { action: 'add', kind: 'stated', content: '用户的银行卡密码是123456' },
      { action: 'add', kind: 'stated', content: '用户每天早上跑步' },
      { action: 'add', kind: 'stated', content: '用户每天早上跑步' },
      { action: 'drop', kind: 'stated', content: '用户不喜欢猫' },
    ]),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })

  assert.deepEqual(
    memoryStore.list(OWNER).map(memory => memory.content),
    ['用户每天早上跑步'],
  )
  assert.deepEqual(
    events.map(event => `${event.op}:${event.reason || event.id?.slice(0, 4)}`),
    ['skip:not_stated', 'skip:sensitive', 'write:mem_', 'skip:duplicate', 'skip:not_stated'],
  )
})

test('never re-adds facts that already exist in long-term memory', async () => {
  const { instance, memoryStore } = extractor({
    llmCall: opsResponse([
      { action: 'add', kind: 'stated', content: '用户每天早上跑步' },
    ]),
  })
  memoryStore.remember(OWNER, '用户每天早上跑步')
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })

  const memories = memoryStore.list(OWNER)
  assert.equal(memories.length, 1)
  // The pre-existing explicit entry keeps its provenance.
  assert.equal(memories[0].source, 'explicit')
})

test('caps the number of writes per run', async () => {
  const { instance, memoryStore } = extractor({
    llmCall: opsResponse(Array.from({ length: 12 }, (_, index) => ({
      action: 'add',
      kind: 'stated',
      content: `用户的第 ${index} 条事实`,
    }))),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(memoryStore.list(OWNER, { limit: 64 }).length, 5)
})

test('stays disabled without an llmCall and skips quiet sessions', async () => {
  const disabled = extractor({ llmCall: null })
  assert.equal(disabled.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)

  let calls = 0
  const quiet = extractor({
    turns: 2,
    llmCall: async () => {
      calls += 1
      return '{"ops":[]}'
    },
  })
  assert.equal(quiet.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)
  assert.equal(calls, 0)
})

test('debounces per owner across repeated session closes', async () => {
  let calls = 0
  let now = 1_000_000
  const memoryStore = new FrontendMemoryStore({ now: () => now })
  const instance = new MemoryExtractor({
    memoryStore,
    conversationSync: chattySession(),
    llmCall: async () => {
      calls += 1
      return '{"ops":[]}'
    },
    logger: { warn: () => {}, debug: () => {} },
    now: () => now,
  })

  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)
  assert.equal(calls, 1)
  now += 31 * 60_000
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(calls, 2)
})

test('survives model failures and invalid JSON without throwing', async () => {
  const events = []
  const failing = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => {
      throw new Error('provider unavailable')
    },
  })
  await failing.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(events.at(-1).op, 'error')

  const invalid = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => 'not json at all',
  })
  await invalid.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(events.at(-1).op, 'error')
})

test('accepts a fenced JSON response', async () => {
  const { instance, memoryStore } = extractor({
    llmCall: async () => '```json\n{"ops":[{"action":"add","kind":"stated","content":"用户住在杭州"}]}\n```',
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.deepEqual(
    memoryStore.list(OWNER).map(memory => memory.content),
    ['用户住在杭州'],
  )
})

test('createExtractorLlmCall requires an api key and posts to chat completions', async () => {
  assert.equal(createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: '',
    model: 'qwen-flash',
  }), null)

  const requests = []
  const llmCall = createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ops":[]}' } }],
        }),
      }
    },
  })
  const text = await llmCall({ system: 'system prompt', user: 'user prompt' })

  assert.equal(text, '{"ops":[]}')
  assert.equal(requests[0].url, 'https://example.com/v1/chat/completions')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key')
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.model, 'qwen-flash')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, 'user prompt')
})

test('createExtractorLlmCall surfaces http errors for the audit trail', async () => {
  const llmCall = createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async () => ({ ok: false, status: 429 }),
  })
  await assert.rejects(
    () => llmCall({ system: 's', user: 'u' }),
    /request failed: 429/,
  )
})
