import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendWorkRuntime } from '../src/backend/backend-work-runtime.mjs'
import { backendInstructionFromWork } from '../src/backend/backend-work-input.mjs'

function backend(overrides = {}) {
  return {
    describe() { return {} },
    async start() {},
    async health() { return { ok: true } },
    async submit() { return { content: '完成', artifacts: [] } },
    status() { return { state: 'working' } },
    async cancel(taskId) { return { taskId, state: 'cancelled' } },
    async respondAuthorization() {},
    async respondInput() {},
    subscribe() { return () => {} },
    async close() {},
    ...overrides,
  }
}

test('submits structured Gateway Work with one model-facing instruction', async () => {
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
    conversationContext: [{ role: 'user', content: '不应转发的历史' }],
    userMemories: [{ scope: 'memory', content: '不应转发的记忆' }],
    workingDirectory: '/project',
    inputParts: [],
  }, {
    ownerId: 'owner-one',
    taskId: 'task_8',
    signal,
    onEvent: event => events.push(event),
  })
  assert.deepEqual(submitted, {
    id: 'task_8',
    ownerId: 'owner-one',
    objective: '检查项目',
    instruction: '检查项目',
    inputParts: [],
  })
  assert.equal(context.signal, signal)
  assert.equal(events.length, 1)
  assert.deepEqual(result, { content: '完成', artifacts: [] })
})

test('keeps model-visible input to one explicit semantic instruction', () => {
  const instruction = backendInstructionFromWork({
    id: 'task_1',
    ownerId: 'owner-one',
    objective: '继续修改首页',
    originalRequest: '继续改刚才那个首页，不要改配色',
    workingDirectory: '/project',
    timeZone: 'Asia/Shanghai',
  })

  assert.equal(instruction, '继续修改首页')
  assert.doesNotMatch(instruction, /task_1|owner-one/u)
})

test('lets a custom adapter provide an explicit semantic instruction', () => {
  assert.equal(backendInstructionFromWork({
    instruction: 'Turn the hardware relay off.',
    objective: 'ignored fallback',
    originalRequest: 'ignored source text',
  }), 'Turn the hardware relay off.')
})

test('uses only BackendPort status and cancellation operations', async () => {
  const calls = []
  const runtime = new BackendWorkRuntime({
    backend: backend({
      status(taskId, options) {
        calls.push(['status', taskId, options])
        return { taskId, state: 'working' }
      },
      async cancel(taskId, options) {
        calls.push(['cancel', taskId, options])
        return { taskId, state: 'cancelled' }
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
