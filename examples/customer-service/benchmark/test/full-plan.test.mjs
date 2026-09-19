import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, summarize } from '../full-plan.mjs'
import { createMaxOnly } from '../max-only.mjs'

test('Full plan includes each task once per mode and interleaves domains', () => {
  const jobs = buildPlan({ retail: [{ id: '0' }, { id: '1' }], airline: [{ id: '0' }] })
  assert.equal(jobs.length, 9)
  assert.equal(new Set(jobs.map(j => `${j.mode}:${j.domain}:${j.taskId}`)).size, 9)
  assert.deepEqual(jobs.slice(0, 3).map(j => j.domain), ['retail', 'airline', 'retail'])
  assert.equal(summarize(jobs)[0].successRate, null)
  for (const job of jobs) Object.assign(job, { status: 'completed', reward: job.taskId === '0' ? 1 : 0 })
  assert.equal(summarize(jobs)[0].successRate, 0.5)
})

test('Max-only continues native tool feedback without an extra classifier', async () => {
  const requests = []
  const scenarios = { async request(method, session, payload) {
    requests.push({ method, session, payload })
    return method === 'agent-step' ? { content: 'done', toolCalls: requests.length === 2 ? 1 : 0 } : {}
  } }
  const client = await createMaxOnly({ scenarios, sessionId: 'tau-test', model: 'max', baseURL: 'test', signal: new AbortController().signal })
  assert.equal(await client.turn('customer'), 'done')
  assert.deepEqual(requests.map(r => r.method), ['agent-init', 'agent-step', 'agent-step'])
  assert.deepEqual(requests[2].payload, {})
  assert.equal(client.counts().agentModelCalls, 2)
})
