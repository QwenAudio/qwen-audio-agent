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
