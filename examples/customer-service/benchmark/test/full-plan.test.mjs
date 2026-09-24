import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, parseConcurrency, parseTimeoutRetries,
  parseHarnessTurnTimeoutSeconds, isTimeoutAttempt, runWithTimeoutRetry, summarize } from '../full-plan.mjs'

test('全量评测并发受上限约束，默认串行', () => {
  assert.equal(parseConcurrency(undefined), 1)
  assert.equal(parseConcurrency('3'), 3)
  for (const value of ['0', '-1', '1.5', '9', 'many', '']) {
    assert.throws(() => parseConcurrency(value), /CS_TAU_CONCURRENCY/)
  }
})

test('可只跑 harness，计划和汇总不混入另外两组', () => {
  const jobs = buildPlan({ retail: [{ id: '0' }], airline: [{ id: '0' }] }, ['harness'])
  assert.deepEqual(jobs.map(job => job.mode), ['harness', 'harness'])
  assert.deepEqual(summarize(jobs, ['harness']).map(row => row.mode), ['harness', 'harness'])
})

test('超时等待默认 180 秒，最多允许一次条件重试', () => {
  assert.equal(parseHarnessTurnTimeoutSeconds(undefined), 180)
  assert.equal(parseHarnessTurnTimeoutSeconds('120'), 120)
  assert.equal(parseTimeoutRetries(undefined), 1)
  assert.equal(parseTimeoutRetries('0'), 0)
  for (const value of ['', '1.5', '-1', '2']) assert.throws(() => parseTimeoutRetries(value))
  for (const value of ['', '0', '301', 'many']) assert.throws(() => parseHarnessTurnTimeoutSeconds(value))
})

test('只重试超时，不重试正常零分或其他失败', () => {
  assert.equal(isTimeoutAttempt({ status: 'completed', failure: 'Realtime harness turn timed out' }), true)
  assert.equal(isTimeoutAttempt({ status: 'completed', terminationReason: 'timeout', failure: 'The operation was aborted' }), true)
  assert.equal(isTimeoutAttempt({ status: 'completed', failure: 'No result: exit=null, signal=SIGTERM' }), true)
  assert.equal(isTimeoutAttempt({ status: 'completed', scoringFailure: 'Judge request timed out' }), true)
  assert.equal(isTimeoutAttempt({ status: 'completed', failure: 'LiteLLM connection error' }), false)
  assert.equal(isTimeoutAttempt({ status: 'completed', reward: 0 }), false)
  assert.equal(isTimeoutAttempt({ status: 'running', failure: 'Realtime harness turn timed out' }), false)
})

test('超时只重跑一次，普通零分不重跑，也不重跑已完成的首跑', async () => {
  const attempts = []
  const job = { attempts: [] }
  const run = async (_job, number) => {
    attempts.push(number)
    job.attempts.push({ status: 'completed', reward: number === 2 ? 1 : 0,
      failure: number === 1 ? 'Realtime harness turn timed out' : undefined })
  }
  await runWithTimeoutRetry(job, run)
  assert.deepEqual(attempts, [1, 2])
  await runWithTimeoutRetry(job, run)
  assert.deepEqual(attempts, [1, 2])
  const normalZero = { attempts: [{ status: 'completed', reward: 0 }] }
  await runWithTimeoutRetry(normalZero, run)
  assert.deepEqual(attempts, [1, 2])
})

test('首跑分数不被重试覆盖，重试恢复另列', () => {
  const jobs = buildPlan({ retail: [], airline: [{ id: '0' }, { id: '1' }] }, ['harness'])
  Object.assign(jobs[0], { status: 'completed', reward: 0, failure: 'Realtime harness turn timed out',
    attempts: [{ status: 'completed', reward: 0 }, { status: 'completed', reward: 1 }] })
  Object.assign(jobs[1], { status: 'completed', reward: 0,
    attempts: [{ status: 'completed', reward: 0 }] })
  const airline = summarize(jobs, ['harness']).find(row => row.domain === 'airline')
  assert.equal(airline.passed, 0)
  assert.equal(airline.infrastructureFailures, 1)
  assert.equal(airline.retried, 1)
  assert.equal(airline.retryRecovered, 1)
  assert.equal(airline.retryAdjustedPassed, 1)
  assert.equal(airline.retryAdjustedSuccessRate, 0.5)
})
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
