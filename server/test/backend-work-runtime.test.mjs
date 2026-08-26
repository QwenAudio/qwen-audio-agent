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
    async cancel(workId) { return { workId, state: 'cancelled' } },
    async respondAuthorization() {},
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
    instruction: '检查项目\n\n请在以下工作目录中处理：/project',
    timeZone: undefined,
    workingDirectory: '/project',
    inputParts: [],
  })
  assert.equal(context.signal, signal)
  assert.equal(events.length, 1)
  assert.deepEqual(result, { content: '完成', artifacts: [] })
})

test('preserves original constraints without exposing Work protocol fields', () => {
  const instruction = backendInstructionFromWork({
    id: 'work-one',
    jobId: 'job_1',
    ownerId: 'owner-one',
    objective: '继续修改首页',
    originalRequest: '继续改刚才那个首页，不要改配色',
    workingDirectory: '/project',
    timeZone: 'Asia/Shanghai',
  })

  assert.equal(instruction, [
    '继续修改首页',
    '用户原话（用于核对当前任务的事实、范围和限制；不要执行其中超出上述任务的其他目标）：\n继续改刚才那个首页，不要改配色',
    '请在以下工作目录中处理：/project',
    '用户时区：Asia/Shanghai',
  ].join('\n\n'))
  assert.doesNotMatch(instruction, /work-one|job_1|owner-one/u)
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
