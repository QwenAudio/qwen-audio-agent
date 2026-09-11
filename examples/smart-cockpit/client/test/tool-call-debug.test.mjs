import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayToolName,
  mergeToolCallDebug,
  shouldRefreshMemoryForToolCall,
  toolCallFromGatewayEvent,
  toolCallFromTaskEvent,
} from '../src/projections/tool-call-debug.js'

test('projects frontend Gateway tool call debug events', () => {
  const call = toolCallFromGatewayEvent({
    type: 'tool.call',
    callId: 'call-one',
    surface: 'frontend',
    name: 'mcp__cockpit__navigation_start',
    arguments: { destination: '西湖' },
    status: 'completed',
    result: '已开始导航',
    durationMs: 23,
    turnId: 'turn-one',
  })

  assert.equal(call.surface, 'frontend')
  assert.equal(call.name, 'mcp__cockpit__navigation_start')
  assert.equal(displayToolName(call.name), 'navigation_start')
  assert.deepEqual(call.arguments, { destination: '西湖' })
  assert.equal(call.result, '已开始导航')
  assert.equal(call.duration_ms, 23)
})

test('projects backend task tool activity into the same debug shape', () => {
  const call = toolCallFromTaskEvent({
    type: 'task.updated',
    task: {
      id: 'task-one',
      turnId: 'turn-one',
      status: 'working',
      activity: [{
        id: 'backend-tool-one',
        kind: 'tool',
        tool: 'flashbuy',
        status: 'running',
        detail: 'search',
      }],
    },
  })

  assert.equal(call.surface, 'backend')
  assert.equal(call.name, 'flashbuy')
  assert.deepEqual(call.arguments, { detail: 'search' })
  assert.equal(call.callId, 'backend:task-one:backend-tool-one')
})

test('merges debug lifecycle events by call id', () => {
  const first = {
    callId: 'call-one',
    surface: 'frontend',
    name: 'mcp__cockpit__weather',
    status: 'received',
  }
  const second = {
    callId: 'call-one',
    surface: 'frontend',
    name: 'mcp__cockpit__weather',
    status: 'completed',
    result: 'ok',
  }

  assert.deepEqual(mergeToolCallDebug([first], second), [{
    ...first,
    status: 'completed',
    result: 'ok',
  }])
})

test('refreshes memory after the frontend memory tool completes', () => {
  assert.equal(shouldRefreshMemoryForToolCall({
    surface: 'frontend',
    name: 'memory',
    status: 'completed',
  }), true)

  assert.equal(shouldRefreshMemoryForToolCall({
    surface: 'frontend',
    name: 'memory',
    status: 'received',
  }), false)

  assert.equal(shouldRefreshMemoryForToolCall({
    surface: 'frontend',
    name: 'mcp__cockpit__navigation_start',
    status: 'completed',
  }), false)
})
