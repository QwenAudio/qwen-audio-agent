import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'

test('keeps recent voice context isolated by owner and voice session', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner-one',
    sessionId: 'voice-one',
    id: 'user-one',
    role: 'user',
    content: '继续首页',
    source: 'voice-user',
  })
  sync.record({
    ownerId: 'owner-two',
    sessionId: 'voice-one',
    id: 'user-two',
    role: 'user',
    content: '其他人的内容',
    source: 'voice-user',
  })
  assert.deepEqual(
    sync.frontendContext({
      ownerId: 'owner-one',
      sessionId: 'voice-one',
    }).map(item => item.content),
    ['继续首页'],
  )
})

test('uses the same bounded forty-message projection for frontend history and Realtime', () => {
  const sync = new ConversationSync()
  for (let index = 1; index <= 44; index += 1) {
    sync.record({
      ownerId: 'owner',
      sessionId: 'voice',
      id: `message-${index}`,
      role: index % 2 ? 'user' : 'assistant',
      content: `message ${index}`,
      source: index % 2 ? 'voice-user' : 'realtime-direct',
    })
  }

  assert.deepEqual(
    sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })
      .map(message => message.content),
    Array.from({ length: 40 }, (_, index) => `message ${index + 5}`),
  )
})

test('restores messages without writing them back through the record observer', () => {
  const observed = []
  const sync = new ConversationSync({ onRecord: message => observed.push(message) })
  sync.restore({
    ownerId: 'owner',
    sessionId: 'voice',
    messages: [{
      id: 'restored',
      role: 'user',
      content: 'persisted message',
      source: 'voice-user',
      createdAt: 123,
    }],
  })

  assert.equal(observed.length, 0)
  assert.equal(sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].createdAt, 123)
})

test('deduplicates the same message id and retains agent presentations', () => {
  const sync = new ConversationSync()
  const input = {
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'same',
    role: 'assistant',
    content: '完成',
    source: 'agent-presentation',
    taskId: 'work-one',
  }
  sync.record(input)
  sync.record(input)
  assert.equal(sync.list({ ownerId: 'owner', sessionId: 'voice' }).length, 1)
  assert.equal(
    sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].content,
    '完成',
  )
})

test('clones citations and preserves them across a duplicate final record', () => {
  const sync = new ConversationSync()
  const citations = [{
    id: 'source_1',
    title: '杭州天气',
    url: 'https://example.com/weather',
  }]
  const base = {
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'answer',
    role: 'assistant',
    content: '今天晴。',
    source: 'realtime-direct',
  }
  sync.record({ ...base, citations })
  citations[0].title = '被篡改'
  sync.record(base)

  const [message] = sync.list({ ownerId: 'owner', sessionId: 'voice' })
  assert.equal(message.citations[0].title, '杭州天气')
  message.citations[0].title = '再次篡改'
  assert.equal(
    sync.list({ ownerId: 'owner', sessionId: 'voice' })[0].citations[0].title,
    '杭州天气',
  )
})

test('retains cloned input references for reconnectable frontend context', () => {
  const sync = new ConversationSync()
  const inputs = [{
    ref: 'input_1',
    type: 'image',
    label: '[Image 1]',
    filename: 'cat.png',
    mime: 'image/png',
  }]
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'image-turn',
    role: 'user',
    content: '[Image 1]',
    source: 'voice-user',
    inputs,
  })
  inputs[0].ref = 'tampered'

  const [message] = sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })
  assert.equal(message.inputs[0].ref, 'input_1')
  message.inputs[0].ref = 'mutated-copy'
  assert.equal(
    sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].inputs[0].ref,
    'input_1',
  )
})

test('restores typed multimodal turns as well as voice turns', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'typed-image-turn',
    role: 'user',
    content: '[Image 1]',
    source: 'text-user',
    inputs: [{ ref: 'input_1', type: 'image', label: '[Image 1]' }],
  })

  assert.equal(
    sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].inputs[0].ref,
    'input_1',
  )
})

test('recognizes equivalent assistant speech only within the same voice turn', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'acknowledgement',
    role: 'assistant',
    content: '正在修改贪吃蛇，让它更酷炫！',
    source: 'realtime-direct',
    turnId: 'turn-one',
  })

  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-one',
    content: '正在修改贪吃蛇，让它更酷炫。',
  }), true)
  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-two',
    content: '正在修改贪吃蛇，让它更酷炫。',
  }), false)
  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-one',
    content: '正在修改登录页面的颜色。',
  }), false)
})

test('recognizes a detailed delegated acknowledgement as the same action preview', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'progress-preview',
    role: 'assistant',
    content: '正在检查当前目录的项目进度。',
    source: 'realtime-direct',
    turnId: 'turn-progress',
  })

  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-progress',
    content: '好的老大，我已经开始检查你当前这个 qwen-audio-agent 项目的进度了，会看一下 git 分支、未提交改动和最近提交。',
  }), true)
})

const recordedContext = { ownerId: 'owner', sessionId: 'voice' }

function liveRecord(sync, id, options = {}) {
  return sync.record({
    ...recordedContext,
    id,
    role: 'user',
    content: `message ${id}`,
    source: 'voice-user',
    ...options,
  })
}

test('pending records exclude restored history and unchanged replayed messages', () => {
  const observed = []
  const sync = new ConversationSync({ onRecord: message => observed.push(message) })
  const consumer = {}
  const restored = { id: 'old', role: 'user', content: 'old preference', source: 'voice-user' }
  sync.restore({ ...recordedContext, messages: [restored] })
  sync.upsert({ ...recordedContext, ...restored, id: 'silent' }, { notify: false })
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])
  assert.equal(observed.length, 0)

  sync.record({ ...recordedContext, ...restored })
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])
  assert.equal(observed.length, 1, 'existing record observer behavior is unchanged')

  const recorded = liveRecord(sync, 'new', { createdAt: 123 })
  const [pending] = sync.pendingRecords(recordedContext, consumer).messages
  assert.deepEqual(pending, recorded)
  assert.equal(pending.seq, 3, 'learning versions do not alter public sequence numbers')
  assert.equal(pending.createdAt, 123)
  assert.deepEqual(Object.keys(pending).sort(), [
    'seq', 'id', 'role', 'content', 'source', 'turnId', 'taskId', 'taskIds', 'inputs', 'createdAt',
  ].sort())
  assert.equal(sync.frontendContext(recordedContext).length, 3)
})

test('record consumers independently consume a batch once across repeated closes', () => {
  const sync = new ConversationSync()
  const extractor = {}
  const observer = {}
  liveRecord(sync, 'one')
  const batch = sync.pendingRecords(recordedContext, extractor)
  assert.equal(batch.messages.length, 1)
  assert.equal(batch.isCurrent(), true)
  batch.consume()
  batch.consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, extractor).messages, [])
  assert.equal(sync.pendingRecords(recordedContext, observer).messages.length, 1)
  sync.pendingRecords(recordedContext, observer).consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, observer).messages, [])
  assert.equal(sync.list(recordedContext).length, 1)
})

test('consuming an earlier snapshot leaves new records pending and cannot rewind a cursor', () => {
  const sync = new ConversationSync()
  const consumer = {}
  liveRecord(sync, 'one')
  const first = sync.pendingRecords(recordedContext, consumer)
  liveRecord(sync, 'two')
  first.consume()
  assert.equal(first.isCurrent(), true, 'new input does not invalidate ongoing work')
  const second = sync.pendingRecords(recordedContext, consumer)
  assert.deepEqual(second.messages.map(message => message.id), ['two'])
  second.consume()
  first.consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])
  liveRecord(sync, 'three')
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.id), ['three'])
})

test('unchanged records do not repeat evidence while content and role corrections do', () => {
  const observed = []
  const sync = new ConversationSync({ onRecord: message => observed.push(message) })
  const consumer = {}
  liveRecord(sync, 'one', { content: 'original words' })
  liveRecord(sync, 'one', { content: '  original\nwords  ', source: 'text-user' })
  assert.equal(sync.pendingRecords(recordedContext, consumer).messages.length, 1)
  sync.pendingRecords(recordedContext, consumer).consume()
  liveRecord(sync, 'one', { content: 'original words', turnId: 'final-turn' })
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])

  liveRecord(sync, 'one', { content: 'corrected words' })
  const corrected = sync.pendingRecords(recordedContext, consumer)
  assert.deepEqual(corrected.messages.map(message => [message.seq, message.content]), [[1, 'corrected words']])
  corrected.consume()
  liveRecord(sync, 'one', { content: 'corrected words', role: 'assistant' })
  assert.equal(sync.pendingRecords(recordedContext, consumer).messages[0].role, 'assistant')
  assert.equal(observed.length, 5)
  assert.equal(sync.list(recordedContext).length, 1)
})

test('pending snapshots are isolated and a same-id correction after a snapshot stays pending', () => {
  const sync = new ConversationSync()
  const consumer = {}
  liveRecord(sync, 'one', {
    inputs: [{ ref: 'image-one' }],
    citations: [{ id: 'citation-one' }],
    taskIds: ['task-one'],
  })
  const batch = sync.pendingRecords(recordedContext, consumer)
  batch.messages[0].inputs[0].ref = 'changed'
  batch.messages[0].citations[0].id = 'changed'
  batch.messages[0].taskIds[0] = 'changed'
  const [independent] = sync.pendingRecords(recordedContext, {}).messages
  assert.equal(independent.inputs[0].ref, 'image-one')
  assert.equal(independent.citations[0].id, 'citation-one')
  assert.equal(independent.taskIds[0], 'task-one')
  assert.deepEqual(independent, sync.list(recordedContext)[0])

  liveRecord(sync, 'one', { content: 'corrected' })
  assert.equal(batch.messages[0].content, 'message one')
  batch.consume()
  const next = sync.pendingRecords(recordedContext, consumer)
  assert.deepEqual(next.messages.map(message => message.content), ['corrected'])
  assert.equal(next.messages[0].seq, 1)
})

test('discard invalidates in-flight batches for only the owner without clearing history', () => {
  const sync = new ConversationSync()
  const consumer = {}
  const secondSession = { ...recordedContext, sessionId: 'second' }
  const otherOwner = { ...recordedContext, ownerId: 'other' }
  liveRecord(sync, 'one')
  liveRecord(sync, 'two', secondSession)
  liveRecord(sync, 'three', otherOwner)
  const scopes = [recordedContext, secondSession, otherOwner]
  const history = scopes.map(scope => sync.frontendContext(scope))
  const batches = scopes.map(scope => sync.pendingRecords(scope, consumer))
  sync.discardRecorded(recordedContext.ownerId)
  assert.deepEqual(batches.map(batch => batch.isCurrent()), [false, false, true])
  assert.deepEqual(scopes.map(scope => sync.pendingRecords(scope, consumer).messages.length), [0, 0, 1])
  assert.deepEqual(scopes.map(scope => sync.frontendContext(scope)), history)

  liveRecord(sync, 'one')
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [], 'duplicate old input stays discarded')
  liveRecord(sync, 'new')
  batches[0].consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.id), ['new'])
  assert.equal(sync.pendingRecords(recordedContext, consumer).isCurrent(), true)
  assert.equal(batches[0].isCurrent(), false)
})

test('pending records stay within message retention and retain only the latest correction', () => {
  const sync = new ConversationSync({ maxMessages: 2 })
  const consumer = {}
  liveRecord(sync, 'one')
  for (let index = 0; index < 20; index += 1) {
    liveRecord(sync, 'one', { content: `correction ${index}` })
  }
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.content), ['correction 19'])
  liveRecord(sync, 'two')
  liveRecord(sync, 'three')
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => [message.seq, message.id]), [[2, 'two'], [3, 'three']])
  sync.restore({
    ...recordedContext,
    messages: [{ id: 'restored', role: 'user', content: 'old persisted input' }],
  })
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.id), ['three'])
})

test('session-count eviction drops records and invalidates issued batches', () => {
  const sync = new ConversationSync({ maxSessions: 2 })
  const consumer = {}
  liveRecord(sync, 'one')
  const first = sync.pendingRecords(recordedContext, consumer)
  liveRecord(sync, 'two', { sessionId: 'second' })
  sync.peek(recordedContext.ownerId, recordedContext.sessionId).lastAccessedAt -= 1000
  liveRecord(sync, 'three', { sessionId: 'third' })
  assert.equal(first.isCurrent(), false)
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])
  assert.equal(sync.sessions.size, 2, 'reading absent records must not create a session')
  liveRecord(sync, 'new')
  assert.equal(first.isCurrent(), false, 'reusing an evicted session key cannot revive its batch')
  first.consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.id), ['new'])
})

test('session TTL expires pending records and invalidates in-flight snapshots', () => {
  const sync = new ConversationSync({ sessionTtlMs: 1000 })
  const consumer = {}
  liveRecord(sync, 'one')
  const batch = sync.pendingRecords(recordedContext, consumer)
  sync.peek(recordedContext.ownerId, recordedContext.sessionId).lastAccessedAt -= 2000
  assert.equal(batch.isCurrent(), false)
  batch.consume()
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages, [])
  assert.equal(sync.sessions.size, 0)
  liveRecord(sync, 'new')
  assert.deepEqual(sync.pendingRecords(recordedContext, consumer).messages.map(message => message.id), ['new'])
})

test('pending records require an object consumer and do not allocate absent sessions', () => {
  const sync = new ConversationSync()
  for (const invalid of [undefined, null, 'consumer', 1]) {
    assert.throws(() => sync.pendingRecords(recordedContext, invalid), /consumer object/)
  }
  const batch = sync.pendingRecords(recordedContext, {})
  assert.deepEqual(batch.messages, [])
  assert.equal(batch.isCurrent(), false)
  batch.consume()
  assert.equal(sync.sessions.size, 0)
})
