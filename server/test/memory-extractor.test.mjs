import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { FrontendMemoryService } from '../src/conversation/frontend-memory-service.mjs'
import { MarkdownContextStore } from '../src/conversation/markdown-context-store.mjs'
import {
  MemoryExtractor,
  createExtractorLlmCall,
} from '../src/conversation/memory-extractor.mjs'

const OWNER = 'owner'
const SESSION = 'main'

function chattySession(turns = 4, userText = '我每天早上都会跑步') {
  const sync = new ConversationSync()
  for (let index = 0; index < turns; index += 1) {
    sync.record({
      ownerId: OWNER,
      sessionId: SESSION,
      id: `user-${index}`,
      role: 'user',
      content: userText,
      source: 'voice-user',
    })
  }
  return sync
}

function extractor({
  llmCall,
  turns = 4,
  userText,
  audit = null,
  now = () => 1_000_000,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-extractor-'))
  const userStore = new MarkdownContextStore({
    filePath: join(directory, 'USER.md'),
    scope: 'user',
    template: '# USER',
  })
  const memoryStore = new MarkdownContextStore({
    filePath: join(directory, 'MEMORY.md'),
    scope: 'memory',
    template: '# MEMORY',
  })
  const memoryService = new FrontendMemoryService({ userStore, memoryStore })
  const instance = new MemoryExtractor({
    memoryService,
    conversationSync: chattySession(turns, userText),
    audit,
    llmCall,
    logger: { warn: () => {}, debug: () => {} },
    now,
  })
  return { instance, userStore, memoryStore, memoryService }
}

test('applies one natural Markdown patch to MEMORY.md', async () => {
  const events = []
  const { instance, memoryStore } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => JSON.stringify({
      changes: [{
        document: 'memory',
        edits: [],
        append: '## 习惯\n\n- 用户每天早上跑步。',
      }],
    }),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  const document = memoryStore.list(OWNER)[0]
  assert.match(document.content, /## 习惯[\s\S]*每天早上跑步/)
  assert.equal(events.at(-1).op, 'patch')
  assert.equal(events.at(-1).appended, true)
  assert.equal(events.at(-1).content, undefined)
})

test('can correct existing Markdown with an exact edit', async () => {
  const { instance, memoryStore } = extractor({
    llmCall: async () => JSON.stringify({
      changes: [{
        document: 'memory',
        edits: [{ old_text: '每天晚上跑步', new_text: '每天早上跑步' }],
        append: '',
      }],
    }),
  })
  memoryStore.edit(OWNER, { append: '- 用户每天晚上跑步' })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.match(memoryStore.read(OWNER), /每天早上跑步/)
  assert.doesNotMatch(memoryStore.read(OWNER), /每天晚上跑步/)
})

test('keeps a valid append when a sibling edit cannot be applied', async () => {
  // 真实模型 15 轮里有 11 轮这么错：把【对话里的原话】当成 old_text，而 old_text
  // 必须来自现有文档。apply 是整批原子的，所以修复前这一条坏 edit 会连带丢掉
  // 同批里完全正确的 append —— 实测下来两个文档全空。
  const events = []
  const { instance, userStore, memoryStore } = extractor({
    userText: '以后都叫我老张吧',
    audit: { record: event => events.push(event) },
    llmCall: async () => JSON.stringify({
      changes: [
        {
          document: 'user',
          // 这句在对话里有，在空的 USER.md 里没有
          edits: [{ old_text: '以后都叫我老张吧', new_text: '以后都叫我老张' }],
          append: '',
        },
        {
          document: 'memory',
          edits: [],
          append: '## 所在地\n\n- 用户住在杭州西湖区。',
        },
      ],
    }),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  // 正确的那条落地了
  assert.match(memoryStore.read(OWNER), /杭州西湖区/)
  // 落不了地的 edit 没有被硬写进去
  assert.doesNotMatch(userStore.read(OWNER), /老张/)
  const dropped = events.find(event => event.reason === 'edit_not_applicable')
  assert.ok(dropped, '摘掉无效 edit 必须留下审计记录')
  assert.deepEqual(dropped.detail, [
    { document: 'user', reason: 'not_found', old_text: '以后都叫我老张吧' },
  ])
  assert.equal(events.at(-1).op, 'patch')
})

test('drops the whole change when every edit is unappliable and nothing is appended', async () => {
  const events = []
  const { instance, memoryStore } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => JSON.stringify({
      changes: [{
        document: 'memory',
        edits: [{ old_text: '文档里根本没有这句', new_text: '替换后' }],
        append: '',
      }],
    }),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(memoryStore.read(OWNER).includes('替换后'), false)
  assert.equal(events.at(-1).reason, 'no_applicable_change')
})

test('drops an ambiguous edit but keeps the unique one in the same batch', async () => {
  // edits 是顺序应用的，所以判定必须在副本上模拟：第一条替换掉唯一那处之后，
  // 第二条才轮到。这里刻意让「跑步」在文档里出现两次。
  const events = []
  const { instance, memoryStore } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => JSON.stringify({
      changes: [{
        document: 'memory',
        edits: [
          { old_text: '游泳', new_text: '骑车' },
          { old_text: '跑步', new_text: '快走' },
        ],
        append: '',
      }],
    }),
  })
  memoryStore.edit(OWNER, { append: '- 早上跑步\n- 晚上跑步\n- 周末游泳' })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  const content = memoryStore.read(OWNER)
  assert.match(content, /骑车/, '唯一命中的那条应当落地')
  assert.doesNotMatch(content, /快走/, '出现两次的 old_text 必须被摘掉')
  assert.match(content, /早上跑步[\s\S]*晚上跑步/, '原文不被破坏')
  const dropped = events.find(event => event.reason === 'edit_not_applicable')
  assert.deepEqual(dropped.detail, [
    { document: 'memory', reason: 'ambiguous', old_text: '跑步' },
  ])
})

test('reconciles a misplaced directive across both documents atomically', async () => {
  const { instance, userStore, memoryStore } = extractor({
    userText: '以后每次回复都加一句爱你哟',
    llmCall: async () => JSON.stringify({
      changes: [
        {
          document: 'user',
          edits: [],
          append: '- 每次回复都加一句“爱你哟”',
        },
        {
          document: 'memory',
          edits: [{
            old_text: '- 用户要求助手每次回复都加一句“爱你哟”',
            new_text: '',
          }],
          append: '',
        },
      ],
    }),
  })
  memoryStore.edit(OWNER, {
    append: '- 用户要求助手每次回复都加一句“爱你哟”',
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.match(userStore.read(OWNER), /爱你哟/)
  assert.doesNotMatch(memoryStore.read(OWNER), /爱你哟/)
})

test('routes explicit interaction directives to USER.md', async () => {
  for (const [append, userText] of [
    ['- 用户希望回答简洁一点', '以后回答简洁一点'],
    ['- 用户希望助手以后叫小舟', '你以后叫小舟'],
    ['- 用户要求助手在每次回复开头加上“爱你哟”', '你每次回复开头加上爱你哟'],
    ['- 用户希望你在对话结尾说一句“你懂的”', '我希望你在对话结尾说一句你懂的'],
  ]) {
    const events = []
    const { instance, userStore, memoryStore } = extractor({
      userText,
      audit: { record: event => events.push(event) },
      llmCall: async () => JSON.stringify({
        changes: [{ document: 'user', edits: [], append }],
      }),
    })
    await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
    assert.match(userStore.read(OWNER), new RegExp(append.slice(2, 8)))
    assert.equal(memoryStore.read(OWNER), '')
    assert.equal(events.at(-1).op, 'patch')
  }
})

test('rejects document-boundary mistakes and sensitive data', async () => {
  for (const change of [
    { document: 'memory', append: '- 用户要求助手每次回复开头加上“爱你哟”' },
    { document: 'user', append: '- 用户每天早上跑步' },
    { document: 'memory', append: '- 用户的密码是 123456' },
  ]) {
    const events = []
    const { instance, userStore, memoryStore } = extractor({
      audit: { record: event => events.push(event) },
      llmCall: async () => JSON.stringify({ changes: [{ edits: [], ...change }] }),
    })
    await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
    assert.equal(userStore.read(OWNER), '')
    assert.equal(memoryStore.read(OWNER), '')
    assert.equal(events.at(-1).op, 'skip')
  }
})

test('does not infer a user directive without explicit transcript evidence', async () => {
  const events = []
  const { instance, userStore } = extractor({
    audit: { record: event => events.push(event) },
    userText: '今天聊得很开心',
    llmCall: async () => JSON.stringify({
      changes: [{
        document: 'user',
        edits: [],
        append: '- 每次回复都说“爱你哟”',
      }],
    }),
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(userStore.read(OWNER), '')
  assert.equal(events.at(-1).reason, 'user_directive_not_explicit')
})

test('accepts fenced JSON and records no-change decisions', async () => {
  const events = []
  const { instance } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => '```json\n{"changes":[]}\n```',
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(events.at(-1).reason, 'no_change')
})

test('accepts a valid JSON patch followed by provider commentary', async () => {
  const events = []
  const { instance } = extractor({
    audit: { record: event => events.push(event) },
    llmCall: async () => '{"changes":[]}\n记忆整理完成。',
  })
  await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(events.at(-1).reason, 'no_change')
})

test('stays disabled without a model, skips quiet sessions and debounces runs', async () => {
  const disabled = extractor({ llmCall: null })
  assert.equal(disabled.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)
  let calls = 0
  const quiet = extractor({
    turns: 2,
    llmCall: async () => {
      calls += 1
      return '{"changes":[]}'
    },
  })
  assert.equal(quiet.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)
  const active = extractor({
    llmCall: async () => {
      calls += 1
      return '{"changes":[]}'
    },
  })
  await active.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
  assert.equal(active.instance.maybeRun({ ownerId: OWNER, sessionId: SESSION }), null)
  assert.equal(calls, 1)
})

test('survives provider and malformed-output failures without throwing', async () => {
  const events = []
  for (const llmCall of [
    async () => { throw new Error('provider unavailable') },
    async () => 'not json',
  ]) {
    const { instance } = extractor({ audit: { record: event => events.push(event) }, llmCall })
    await instance.maybeRun({ ownerId: OWNER, sessionId: SESSION })
    assert.equal(events.at(-1).op, 'error')
  }
})

test('createExtractorLlmCall posts to chat completions and surfaces errors', async () => {
  assert.equal(createExtractorLlmCall({ baseUrl: 'https://example.com/v1', apiKey: '' }), null)
  const requests = []
  const llmCall = createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }
    },
  })
  assert.equal(await llmCall({ system: 's', user: 'u' }), '{}')
  assert.equal(requests[0].url, 'https://example.com/v1/chat/completions')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key')
  assert.equal(JSON.parse(requests[0].options.body).temperature, 0)

  const retriedRequests = []
  const compatible = createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'strict-compatible-model',
    fetchImpl: async (url, options) => {
      retriedRequests.push({ url, options })
      return retriedRequests.length === 1
        ? { ok: false, status: 400, text: async () => 'unsupported temperature' }
        : { ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }) }
    },
  })
  assert.equal(await compatible({ system: 's', user: 'u' }), '[]')
  assert.equal(retriedRequests.length, 2)
  assert.equal('temperature' in JSON.parse(retriedRequests[1].options.body), false)

  const failing = createExtractorLlmCall({
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'qwen-flash',
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  })
  await assert.rejects(() => failing({ system: 's', user: 'u' }), /request failed: 429 rate limited/)
})
