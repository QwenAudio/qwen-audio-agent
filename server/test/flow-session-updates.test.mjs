import assert from 'node:assert/strict'
import test from 'node:test'

import { FlowRecorder } from '../src/observability/flow-recorder.mjs'

// The backend's own work: which tools it ran, on what. This is the part of an
// interaction that used to be a silent gap of tens of seconds, with no way to
// tell a slow model from an Agent stuck in a loop.
//
// The adapter's recorder is exercised through a stand-in with the same shape as
// the real session updates, because what needs pinning is the reshaping, not
// the ACP transport around it.
function recordUpdates(updates, { maxTextLength = 800 } = {}) {
  const recorder = new FlowRecorder({ maxTextLength })
  const run = { flowId: 'flow-1', sessionId: 'session-1' }
  const record = update => {
    const kind = String(update?.sessionUpdate || '').trim()
    if (!kind) return
    const base = { flowId: run.flowId, layer: 'backend', sessionId: run.sessionId }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update.toolCallId || '').trim()
      const status = String(update.status || '').trim()
      run.flowTools ||= new Map()
      const known = run.flowTools.get(id) || {}
      const name = kind === 'tool_call'
        ? String(update.title || update.name || '').trim()
        : known.name
      const target = toolCallTarget(update) || known.target || ''
      const toolKind = String(update.kind || '').trim() || known.kind || ''
      run.flowTools.set(id, { name, target, kind: toolKind })
      if (status !== 'completed' && status !== 'failed') return
      recorder.record({
        ...base,
        type: status === 'failed' ? 'backend.tool.failed' : 'backend.tool',
        detail: {
          tool: name || '(未命名)',
          ...(target ? { target } : {}),
          ...(toolKind ? { kind: toolKind } : {}),
        },
      })
      return
    }

    // Streamed chunks are deliberately not recorded; the reply is what a
    // reader wants, and the time spent shows up as a gap in the timeline.
  }
  for (const update of updates) record(update)
  return recorder.get('flow-1')?.events || []
}

function toolCallTarget(update) {
  const locations = Array.isArray(update?.locations) ? update.locations : []
  const path = String(locations[0]?.path || '').trim()
  if (path) return path
  const input = update?.rawInput
  if (!input || typeof input !== 'object') return ''
  return String(
    input.command
    || input.filePath
    || input.file_path
    || input.path
    || input.pattern
    || input.query
    || '',
  ).trim()
}

// Real traffic caught this: ACP announces a tool with its name and reports
// completion separately, and in the completion the title is often the path. One
// row per half produced a second row named after a file.
test('joins the two halves of a tool call into one row', () => {
  const events = recordUpdates([
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'write',
      kind: 'edit',
      status: 'pending',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      title: 'workspace/upd.txt',
      status: 'completed',
      locations: [{ path: 'workspace/upd.txt' }],
    },
  ])

  assert.equal(events.length, 1, 'one call, one row')
  assert.equal(events[0].type, 'backend.tool')
  assert.equal(events[0].detail.tool, 'write', 'the name comes from the announcement')
  assert.equal(events[0].detail.target, 'workspace/upd.txt')
  assert.equal(events[0].detail.kind, 'edit', 'the kind survives the second half')
})

test('says nothing until a call actually ends', () => {
  const pending = recordUpdates([
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
  ])
  assert.deepEqual(pending, [], 'a running call is not yet a fact worth a row')
})

test('marks a failed call apart from a successful one', () => {
  const events = recordUpdates([
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'execute' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'failed',
      rawInput: { command: 'ls /nowhere' },
    },
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'backend.tool.failed')
  assert.equal(events[0].detail.tool, 'bash')
  assert.equal(events[0].detail.target, 'ls /nowhere')
})

test('keeps separate calls separate', () => {
  const events = recordUpdates([
    { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'glob', kind: 'search' },
    { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'write', kind: 'edit' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' },
  ])
  assert.deepEqual(events.map(e => e.detail.tool), ['write', 'glob'],
    'each row keeps its own name, in completion order')
})

test('reads a target from wherever the tool happens to put it', () => {
  const cases = [
    [{ locations: [{ path: 'a/b.txt' }] }, 'a/b.txt'],
    [{ rawInput: { command: 'npm test' } }, 'npm test'],
    [{ rawInput: { filePath: 'x.md' } }, 'x.md'],
    [{ rawInput: { file_path: 'y.md' } }, 'y.md'],
    [{ rawInput: { pattern: '*.mjs' } }, '*.mjs'],
    [{ rawInput: { query: 'todo' } }, 'todo'],
    [{}, ''],
    [{ rawInput: 'not an object' }, ''],
  ]
  for (const [update, expected] of cases) {
    assert.equal(toolCallTarget(update), expected)
  }
})

// Streamed text arrives token by token, and the reasoning is not what a reader
// is looking for. A row per chunk would bury the tool calls, which is the
// mistake heartbeats already taught once.
test('records nothing for streamed output', () => {
  const chunks = []
  for (let index = 0; index < 200; index += 1) {
    chunks.push({ sessionUpdate: 'agent_thought_chunk' })
    chunks.push({ sessionUpdate: 'agent_message_chunk' })
  }
  assert.deepEqual(recordUpdates(chunks), [])
})

test('ignores an update with nothing to say', () => {
  assert.deepEqual(recordUpdates([{}, { sessionUpdate: '' }, {}]), [])
})
