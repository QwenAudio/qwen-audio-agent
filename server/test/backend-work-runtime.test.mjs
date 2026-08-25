import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendWorkRuntime } from '../src/backend/backend-work-runtime.mjs'

function backend(overrides = {}) {
  return {
    describe() { return {} },
    async start() {},
    async health() { return { ok: true } },
    async submit() { return { content: '完成', artifacts: [] } },
    status() { return { state: 'working' } },
    async cancel(workId) { return { workId, state: 'cancelled' } },
    async respondAuthorization() {},
    subscribe() { return () => {} },
    async close() {},
    ...overrides,
  }
}

test('submits Gateway Work context without protocol or Session fields', async () => {
  let submitted
  let context
  const events = []
  const runtime = new BackendWorkRuntime({
    backend: backend({
      async submit(work, options) {
        submitted = work
        context = options
        options.onEvent({ type: 'backend.activity' })
        return { content: '完成', artifacts: [] }
      },
    }),
  })
  const signal = new AbortController().signal
  const result = await runtime.run({
    originalRequest: '检查项目',
    objective: '检查项目',
    conversationContext: [{ role: 'user', content: '继续' }],
    inputParts: [],
  }, {
    ownerId: 'owner-one',
    workId: 'work-one',
    jobId: 'job_8',
    signal,
    onEvent: event => events.push(event),
  })
  assert.deepEqual(submitted, {
    id: 'work-one',
    jobId: 'job_8',
    ownerId: 'owner-one',
    originalRequest: '检查项目',
    objective: '检查项目',
    conversationContext: [{ role: 'user', content: '继续' }],
    userMemories: [],
    timeZone: undefined,
    workingDirectory: undefined,
    inputParts: [],
  })
  assert.equal(context.signal, signal)
  assert.equal(events.length, 1)
  assert.deepEqual(result, { content: '完成', artifacts: [] })
})

test('uses only BackendPort status and cancellation operations', async () => {
  const calls = []
  const runtime = new BackendWorkRuntime({
    backend: backend({
      status(workId, options) {
        calls.push(['status', workId, options])
        return { workId, state: 'working' }
      },
      async cancel(workId, options) {
        calls.push(['cancel', workId, options])
        return { workId, state: 'cancelled' }
      },
    }),
  })
  assert.equal(runtime.status('work-one', { ownerId: 'owner' }).state, 'working')
  assert.equal((await runtime.cancel('work-one', { ownerId: 'owner' })).state, 'cancelled')
  assert.deepEqual(calls, [
    ['status', 'work-one', { ownerId: 'owner' }],
    ['cancel', 'work-one', { ownerId: 'owner' }],
  ])
})
