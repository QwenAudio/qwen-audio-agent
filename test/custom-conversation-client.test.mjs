import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  conversationSocketUrl,
  createConnectionMessage,
  createTextInputMessage,
  displayServerMessage,
} from '../examples/custom-conversation-client/client.mjs'
import {
  parseGatewayClientMessage,
  parseGatewayServerMessage,
} from 'qwen-audio-agent/gateway-events'

test('custom client builds messages accepted by the public Gateway schemas', () => {
  assert.equal(
    conversationSocketUrl('https://voice.example.com/base', 'cockpit'),
    'wss://voice.example.com/api/realtime?sessionId=cockpit',
  )
  assert.equal(parseGatewayClientMessage(createConnectionMessage()).type, 'connect')
  assert.deepEqual(
    parseGatewayClientMessage(createTextInputMessage('打开空调')).parts,
    [{ type: 'text', text: '打开空调' }],
  )
  assert.throws(() => parseGatewayClientMessage(createTextInputMessage('')))
})

test('custom client consumes public conversation and Task events', () => {
  const output = []
  displayServerMessage({
    type: 'transcript.final',
    role: 'assistant',
    content: '空调已打开。',
  }, value => output.push(value))
  assert.deepEqual(output, ['assistant: 空调已打开。'])

  assert.equal(parseGatewayServerMessage({
    type: 'voice.ready',
    inputSampleRate: 16_000,
    provider: 'dashscope',
  }).type, 'voice.ready')
  assert.equal(parseGatewayServerMessage({
    type: 'task.running',
    task: {
      id: 'task_1',
      workState: 'working',
      status: 'running',
      kind: 'work',
      objective: '检查车辆状态',
      createdAt: 1,
      elapsedMs: 0,
    },
  }).task.id, 'task_1')
})

test('custom client imports only public package entries', async () => {
  const source = await readFile(
    new URL('../examples/custom-conversation-client/client.mjs', import.meta.url),
    'utf8',
  )
  assert.match(source, /from 'qwen-audio-agent\/realtime-events'/)
  assert.match(source, /from 'qwen-audio-agent\/gateway-events'/)
  assert.doesNotMatch(source, /(?:server|shared|web|desktop|tui)\/(?:src|protocol)/)
})
