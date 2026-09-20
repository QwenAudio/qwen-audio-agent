import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitAgentExecutor } from '../executor.mjs'
import { startCockpitAgentServer } from '../server.mjs'
import { A2ABackendAdapter } from 'qwen-audio-agent/a2a-backend-adapter'

function request(taskId, text, contextId = 'driver-one') {
  return {
    taskId, contextId,
    userMessage: { parts: [{ content: { $case: 'text', value: text } }] },
  }
}

test('new cockpit Tasks retain previous requests/replies, isolate drivers, and cap input at 50 turns', async () => {
  const seen = []
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [], call() {} },
    model: { async complete({ messages }) {
      seen.push(structuredClone(messages))
      return { content: `reply to ${messages.at(-1).content}` }
    } },
  })
  const bus = { publish() {} }
  await executor.execute(request('task-1', '做一份报告'), bus)
  await executor.execute(request('task-2', '把刚才的报告简短一点'), bus)
  assert.deepEqual(seen[1].slice(1, -1), [
    { role: 'user', content: '做一份报告' },
    { role: 'assistant', content: 'reply to 做一份报告' },
  ])
  await executor.execute(request('task-3', 'another driver', 'driver-two'), bus)
  assert.equal(seen[2].length, 2)
  for (let i = 0; i < 55; i++) await executor.execute(request(`turn-${i}`, `task-${i}`), bus)
  assert.equal(seen.at(-1).length, 100) // system + 49 pairs + current request
  assert.equal(seen.at(-1)[1].content, 'task-5')
  assert.equal(executor.history.contexts.get('driver-one').length, 50)
})

test('real A2A submissions keep cockpit context across new Tasks without sharing isolated/other-owner work', async t => {
  const seen = []
  const agent = await startCockpitAgentServer({
    port: 0,
    tools: { list: async () => [], call() {} },
    model: { async complete({ messages }) {
      seen.push(structuredClone(messages))
      return { content: `result: ${messages.at(-1).content}` }
    } },
  })
  t.after(() => agent.close())
  const backend = new A2ABackendAdapter({ agentCardUrl: agent.agentCardUrl, reuseContext: true })
  t.after(() => backend.close())
  await backend.submit({ id: 'task-1', ownerId: 'driver-one', objective: 'previous report' })
  await backend.submit({ id: 'task-2', ownerId: 'driver-one', objective: 'make it shorter' })
  assert.equal(seen[1][1].content, 'previous report')
  assert.equal(seen[1][2].content, 'result: previous report')
  await backend.submit({ id: 'utility', ownerId: 'driver-one', objective: 'private utility', continuity: 'isolated' })
  await backend.submit({ id: 'task-3', ownerId: 'driver-two', objective: 'other owner' })
  assert.equal(seen[2].length, 2)
  assert.equal(seen[3].length, 2)
  await backend.submit({ id: 'task-4', ownerId: 'driver-one', objective: 'continue' })
  assert.equal(seen[4].length, 6)
  assert.doesNotMatch(JSON.stringify(seen[4]), /private utility|other owner/)
})

test('follow-up report edits retain full content and source provenance without hiding failed new retrieval', async () => {
  const replies = [
    { tool_calls: [{ id: 'search-one', function: { name: 'web_search', arguments: '{}' } }] },
    { content: '<cockpit_report>Full report: details not in the spoken summary.</cockpit_report><cockpit_summary>Brief summary.</cockpit_summary>' },
    { content: '<cockpit_report>Shorter version.</cockpit_report><cockpit_summary>Rewritten.</cockpit_summary>' },
    { tool_calls: [{ id: 'search-two', function: { name: 'web_search', arguments: '{}' } }] },
    { content: '<cockpit_report>Unverified new claims.</cockpit_report>' },
  ]
  const seen = []
  let lookups = 0
  const executor = new CockpitAgentExecutor({
    tools: {
      list: async () => [{ name: 'web_search', inputSchema: { type: 'object' } }],
      async call() {
        const ok = ++lookups === 1
        return {
          content: ok ? 'Search result' : 'Lookup failed',
          data: {
            status: ok ? 'ok' : 'error',
            error_code: ok ? undefined : 'unavailable',
            citations: ok ? [{ title: 'Source', url: 'https://example.com/source' }] : [],
            retrieval: { tool: 'web_search', retrieved_at: '2026-09-21T00:00:00Z' },
          },
        }
      },
    },
    model: { async complete({ messages }) {
      seen.push(structuredClone(messages))
      return replies.shift()
    } },
  })
  const events = []
  const bus = { publish: event => events.push(event) }
  await executor.execute(request('research', 'Research a topic'), bus)
  await executor.execute(request('edit', 'Shorten the report'), bus)
  assert.match(seen[2][2].content, /details not in the spoken summary/u)
  assert.doesNotMatch(JSON.stringify(seen[2]), /tool_call_id|search-one/u)
  const edited = events.filter(event => event.kind === 'artifactUpdate').at(-1).data.artifact
  assert.match(edited.parts[0].content.value, /Shorter version/u)
  assert.match(edited.parts[0].content.value, /此前任务的来源/u)
  assert.match(edited.parts[0].content.value, /未重新检索/u)
  assert.equal(edited.metadata.sources[0].url, 'https://example.com/source')
  await executor.execute(request('new-research', 'Find the latest news'), bus)
  const failedLookup = events.filter(event => event.kind === 'artifactUpdate').at(-1).data.artifact
  assert.match(failedLookup.parts[0].content.value, /未能取得可核验的网页来源/u)
  assert.doesNotMatch(failedLookup.parts[0].content.value, /Unverified new claims|example.com/u)
  assert.deepEqual(failedLookup.metadata.sources, [])
})
