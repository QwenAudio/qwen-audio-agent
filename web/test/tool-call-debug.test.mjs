import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayServerEvent } from '../../shared/realtime-events.mjs'
import {
  cancelToolCallsForResponse,
  displayToolName,
  mergeToolCallDebug,
  toolCallFromGatewayEvent,
} from '../src/tool-call-debug.js'

test('normalizes a tool-call event without retaining content payloads', () => {
  const toolCall = toolCallFromGatewayEvent({
    type: GatewayServerEvent.TOOL_CALL,
    callId: 'call_1',
    name: 'mcp__cockpit__navigation_start',
    surface: 'frontend',
    status: 'received',
    arguments: { destination: '西湖', token: 'should-not-be-retained' },
    result: 'private tool output',
    durationMs: -1,
    createdAt: 100,
    responseId: 'response_1',
    turnId: 'turn_1',
  })

  assert.deepEqual(toolCall, {
    callId: 'call_1',
    name: 'mcp__cockpit__navigation_start',
    surface: 'frontend',
    status: 'received',
    createdAt: 100,
    responseId: 'response_1',
    turnId: 'turn_1',
  })
  assert.equal(displayToolName(toolCall.name), 'navigation start')
})

test('uses the current turn when an event omits its turn id', () => {
  const toolCall = toolCallFromGatewayEvent({
    type: GatewayServerEvent.TOOL_CALL,
    callId: 'call_2',
    name: 'get_current_time',
    surface: 'frontend',
    status: 'running',
  }, 'turn_fallback')

  assert.equal(toolCall.turnId, 'turn_fallback')
  assert.equal(toolCall.status, 'running')
})

test('merges a call lifecycle by call id and preserves first observation order', () => {
  let calls = mergeToolCallDebug([], {
    callId: 'call_1',
    name: 'get_current_time',
    surface: 'frontend',
    status: 'received',
    createdAt: 100,
    responseId: 'response_1',
    turnId: 'turn_1',
  })
  calls = mergeToolCallDebug(calls, {
    callId: 'call_1',
    name: 'get_current_time',
    surface: 'frontend',
    status: 'completed',
    durationMs: 24,
    taskId: 'task_1',
    createdAt: 200,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].status, 'completed')
  assert.equal(calls[0].createdAt, 100)
  assert.equal(calls[0].durationMs, 24)
  assert.equal(calls[0].taskId, 'task_1')

  const settled = calls
  calls = mergeToolCallDebug(calls, {
    callId: 'call_1',
    name: 'get_current_time',
    surface: 'frontend',
    status: 'received',
    createdAt: 300,
  })
  assert.equal(calls[0].status, 'completed')
  assert.strictEqual(calls[0].createdAt, settled[0].createdAt)
})

test('bounds retained tool calls while allowing terminal updates', () => {
  let calls = [
    { callId: 'call_1', name: 'one', surface: 'frontend', status: 'completed' },
    { callId: 'call_2', name: 'two', surface: 'frontend', status: 'completed' },
  ]
  calls = mergeToolCallDebug(calls, {
    callId: 'call_3',
    name: 'three',
    surface: 'backend',
    status: 'received',
  }, { max: 2 })
  assert.deepEqual(calls.map(call => call.callId), ['call_2', 'call_3'])

  calls = mergeToolCallDebug(calls, {
    callId: 'call_3',
    name: 'three',
    surface: 'backend',
    status: 'completed',
    durationMs: 50,
  }, { max: 2 })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].status, 'completed')
  assert.equal(calls[1].durationMs, 50)
})

test('marks only interrupted in-flight calls as cancelled', () => {
  const calls = [
    {
      callId: 'call_active',
      name: 'web_search',
      surface: 'frontend',
      status: 'running',
      responseId: 'response_1',
    },
    {
      callId: 'call_done',
      name: 'get_current_time',
      surface: 'frontend',
      status: 'completed',
      responseId: 'response_1',
    },
    {
      callId: 'call_other',
      name: 'notes',
      surface: 'frontend',
      status: 'running',
      responseId: 'response_2',
    },
  ]

  const cancelled = cancelToolCallsForResponse(calls, 'response_1')
  assert.equal(cancelled[0].status, 'cancelled')
  assert.equal(cancelled[1].status, 'completed')
  assert.equal(cancelled[2].status, 'running')
  assert.strictEqual(cancelToolCallsForResponse(cancelled, 'response_1'), cancelled)
})

test('ignores malformed or unrelated events', () => {
  assert.equal(toolCallFromGatewayEvent(null), null)
  assert.equal(toolCallFromGatewayEvent({ type: 'transcript.final' }), null)
  assert.equal(toolCallFromGatewayEvent({
    type: GatewayServerEvent.TOOL_CALL,
    name: 'missing-call-id',
    surface: 'frontend',
    status: 'received',
  }), null)
  assert.equal(toolCallFromGatewayEvent({
    type: GatewayServerEvent.TOOL_CALL,
    callId: 'call-invalid-surface',
    name: 'unknown',
    surface: 'private',
    status: 'received',
  }), null)
})
