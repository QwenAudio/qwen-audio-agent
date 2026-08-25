import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundFrontendToolResult,
  FrontendToolLoop,
} from '../src/voice/tools/frontend-tool-loop.mjs'

const tool = { name: 'example' }

test('admits distinct calls within one bounded turn', () => {
  const loop = new FrontendToolLoop({ maxCallsPerTurn: 2 })

  assert.equal(loop.admit({ turnId: 'turn', tool, args: { value: 1 } }).admitted, true)
  assert.equal(loop.admit({ turnId: 'turn', tool, args: { value: 2 } }).admitted, true)
  assert.equal(loop.admit({ turnId: 'turn', tool, args: { value: 3 } }).reason, 'call_limit')
})

test('applies a per-tool call limit without consuming other tool budgets', () => {
  const loop = new FrontendToolLoop({ maxCallsPerTurn: 4 })
  const limited = {
    name: 'limited',
    policy: { maxCallsPerTurn: 1 },
  }
  const other = {
    name: 'other',
    policy: { maxCallsPerTurn: 2 },
  }

  assert.equal(loop.admit({
    turnId: 'turn',
    tool: limited,
    args: { value: 1 },
  }).admitted, true)
  assert.equal(loop.admit({
    turnId: 'turn',
    tool: limited,
    args: { value: 2 },
  }).reason, 'tool_call_limit')
  assert.equal(loop.admit({
    turnId: 'turn',
    tool: other,
    args: { value: 1 },
  }).admitted, true)
})

test('blocks an exact repeated call before executing it again', () => {
  const loop = new FrontendToolLoop()

  assert.equal(loop.admit({
    turnId: 'turn',
    tool,
    args: { second: 2, first: 1 },
  }).admitted, true)
  assert.equal(loop.admit({
    turnId: 'turn',
    tool,
    args: { first: 1, second: 2 },
  }).reason, 'repeated_call')
})

test('lets a tool with richer idempotency semantics handle its own repeats', () => {
  const loop = new FrontendToolLoop()
  const guardedTool = {
    name: 'guarded',
    policy: { repeatHandling: 'handler' },
  }

  assert.equal(loop.admit({
    turnId: 'turn',
    tool: guardedTool,
    args: { value: 1 },
  }).admitted, true)
  assert.equal(loop.admit({
    turnId: 'turn',
    tool: guardedTool,
    args: { value: 1 },
  }).admitted, true)
})

test('starts a fresh budget for a new turn or generation', () => {
  const loop = new FrontendToolLoop()
  const input = { tool, args: { value: 1 } }

  assert.equal(loop.admit({ ...input, turnId: 'one', turnGeneration: 1 }).admitted, true)
  assert.equal(loop.admit({ ...input, turnId: 'two', turnGeneration: 1 }).admitted, true)
  assert.equal(loop.admit({ ...input, turnId: 'one', turnGeneration: 2 }).admitted, true)
})

test('stops a tool loop after its total duration budget', () => {
  let now = 1_000
  const loop = new FrontendToolLoop({
    maxDurationMs: 100,
    now: () => now,
  })

  assert.equal(loop.admit({ turnId: 'turn', tool, args: { value: 1 } }).admitted, true)
  now += 101
  assert.equal(loop.admit({
    turnId: 'turn',
    tool,
    args: { value: 2 },
  }).reason, 'duration_limit')
})

test('bounds serialized tool results before they return to the model', () => {
  const accepted = { status: 'ok', content: 'short' }
  assert.deepEqual(boundFrontendToolResult(accepted, 100).value, accepted)

  const rejected = boundFrontendToolResult({ content: 'x'.repeat(100) }, 20)
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.bytes > rejected.maxBytes, true)

  const circular = {}
  circular.self = circular
  assert.equal(boundFrontendToolResult(circular).accepted, false)
})
