import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AguiEventType,
  parseAguiGatewayEvent,
} from '../shared/protocol/agui-events.mjs'
import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  parseGatewayClientMessage,
  parseGatewayServerMessage,
} from '../shared/protocol/gateway-events.mjs'

function task(overrides = {}) {
  return {
    id: 'task_1',
    workState: 'working',
    status: 'running',
    kind: 'work',
    objective: 'test work',
    createdAt: 1,
    elapsedMs: 0,
    ...overrides,
  }
}

test('validates client event envelopes and preserves extension fields', () => {
  assert.deepEqual(parseGatewayClientMessage({
    type: 'connect',
    provider: 'dashscope',
    clientExtension: { inputSampleRate: 16_000 },
  }), {
    type: 'connect',
    provider: 'dashscope',
    clientExtension: { inputSampleRate: 16_000 },
  })

  assert.equal(
    GatewayClientMessageSchema.safeParse({ type: 'voice.ready' }).success,
    false,
  )
  assert.equal(GatewayClientMessageSchema.safeParse(null).success, false)

  assert.equal(parseGatewayClientMessage({
    type: 'input.message',
    parts: [
      { type: 'text', text: '检查前方天气' },
      {
        type: 'file',
        mime: 'image/jpeg',
        filename: 'road.jpg',
        url: 'data:image/jpeg;base64,YQ==',
      },
    ],
  }).parts.length, 2)
  assert.equal(GatewayClientMessageSchema.safeParse({
    type: 'input.message',
    parts: [],
  }).success, false)
  assert.equal(GatewayClientMessageSchema.safeParse({
    type: 'audio.append',
  }).success, false)
  assert.equal(GatewayClientMessageSchema.safeParse({
    type: 'playback.ended',
  }).success, false)
})

test('validates voice and task messages in the server direction', () => {
  assert.deepEqual(parseGatewayServerMessage({
    type: 'voice.ready',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
  }), {
    type: 'voice.ready',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
  })

  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'task.accepted',
      task: task(),
    }).success,
    true,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'task.accepted',
      task: { id: 'task_1' },
    }).success,
    false,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'voice.ready',
      inputSampleRate: 0,
    }).success,
    false,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'audio.delta',
      audio: 'YQ==',
      sampleRate: 24_000,
    }).success,
    false,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({ type: 'connect' }).success,
    false,
  )

  const citation = {
    id: 'source_1',
    title: 'Example source',
    url: 'https://example.com/page',
    snippet: 'A bounded factual excerpt.',
    source: 'example.com',
  }
  assert.equal(GatewayServerMessageSchema.safeParse({
    type: 'transcript.final',
    role: 'assistant',
    content: 'Answer with a source.',
    citations: [citation],
  }).success, true)
  assert.equal(GatewayServerMessageSchema.safeParse({
    type: 'transcript.delta',
    role: 'assistant',
    content: 'Answer',
    citations: [citation],
  }).success, false)
  assert.equal(GatewayServerMessageSchema.safeParse({
    type: 'transcript.final',
    role: 'assistant',
    content: 'Answer',
    citations: [{ ...citation, url: 'https://user:secret@example.com/' }],
  }).success, false)
})

test('preserves protocol-neutral backend observations and safe permission details', () => {
  const message = parseGatewayServerMessage({
    type: 'task.permission.requested',
    task: task({
      activity: [{
        id: 'provider-progress',
        kind: 'custom-progress',
        status: 'running',
        providerHint: 'kept for an extension-aware client',
      }],
      authorization: {
        id: 'auth_1',
        taskId: 'task_1',
        status: 'pending',
        category: 'execute',
        summary: '检查内存：sysctl -n hw.memsize',
        patterns: [],
        approvalScope: 'session',
        operation: {
          title: '检查内存',
          kind: 'execute',
          command: 'sysctl -n hw.memsize',
        },
        createdAt: 1,
        resolvedAt: null,
      },
    }),
  })

  assert.equal(message.task.activity[0].kind, 'custom-progress')
  assert.equal(
    message.task.activity[0].providerHint,
    'kept for an extension-aware client',
  )
  assert.equal(message.task.authorization.approvalScope, 'session')
  assert.equal(
    message.task.authorization.operation.command,
    'sysctl -n hw.memsize',
  )
  assert.equal('presentation' in message.task, false)
})

test('validates the supported AG-UI activity event surface', () => {
  const event = parseAguiGatewayEvent({
    type: AguiEventType.ACTIVITY_SNAPSHOT,
    messageId: 'qwen.audio.task:work_1',
    activityType: 'qwen.audio.task',
    content: { task: { status: 'running' } },
  })

  assert.equal(event.replace, true)
  assert.equal(event.activityType, 'qwen.audio.task')
})
