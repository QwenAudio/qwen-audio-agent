import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { SessionDigestPool } from '../src/conversation/session-digest.mjs'
import {
  FRONTEND_RECALL_CAPABILITY,
  RECALL_TOOL_NAME,
  frontendTools,
} from '../src/voice/frontend-tools.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

// 相对「当下」构造：recall 处理器内部用的是真实 Date.now()，把基准写成固定
// 日期的话，测试会在跨过那一天之后开始漂移（3 天前变成 4 天前）。
const NOW = Date.now()
const DAY = 86_400_000

function harness({
  sessionDigests = null,
  clientContext = { timeZone: 'Asia/Shanghai' },
  manager = new TaskManager(),
} = {}) {
  const outputs = []
  const handler = new ToolCallHandler({
    taskManager: manager,
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts: new TurnTranscripts({ waitMs: 5 }),
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
      ensureResponse: async () => {},
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    backendRuntime: { run: async () => ({ content: '完成', metadata: {} }) },
    getClientContext: () => clientContext,
    sessionDigests,
  })
  // sendFunctionOutput(callId, payload, ...) —— payload 已经是对象，不是 JSON 串
  const lastOutput = () => outputs.at(-1)[1]
  return { handler, outputs, lastOutput, manager }
}

// 走 sanitise 而不是硬塞，这样测试数据和真实落盘数据经过同一道校验 ——
// 否则测试可能在池子拒收的形状上通过。
function digestPool(entries = []) {
  const pool = new SessionDigestPool({ now: () => NOW })
  pool.loaded = true
  for (const entry of entries) {
    const digest = pool.sanitise(entry)
    if (!digest) throw new Error(`测试数据被池子拒收：${JSON.stringify(entry)}`)
    pool.owners.set('owner', [...(pool.owners.get('owner') || []), digest])
  }
  return pool
}

const call = args => ({
  name: RECALL_TOOL_NAME,
  call_id: 'call-1',
  arguments: JSON.stringify(args),
})

test('finds a past conversation by topic and describes when it happened', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([
      {
        session: 's_a',
        at: NOW - 3 * DAY,
        turns: 42,
        topics: ['LOCOMO', '压缩评测'],
        gist: '对比五个方案，two_tier 最优',
      },
    ]),
  })
  await handler.handle(call({ query: 'LOCOMO' }))
  const output = lastOutput()
  assert.equal(output.status, 'found')
  assert.equal(output.sessions.length, 1)
  assert.equal(output.sessions[0].when, '3 天前')
  assert.equal(output.sessions[0].gist, '对比五个方案，two_tier 最优')
  assert.deepEqual(output.sessions[0].topics, ['LOCOMO', '压缩评测'])
  assert.match(output.sessions[0].date, /^\d{4}-\d{2}-\d{2}$/)
})

test('never returns raw transcript or session internals', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([
      { session: 's_secret_id', at: NOW - DAY, turns: 9, topics: ['话题'], gist: '要点' },
    ]),
  })
  await handler.handle(call({}))
  const [session] = lastOutput().sessions
  // 前端在「聊过什么」这一层收手：不给会话 id，不给原话
  assert.equal(session.session, undefined)
  assert.deepEqual(
    Object.keys(session).sort(),
    ['date', 'days_ago', 'gist', 'topics', 'turns', 'when'],
  )
})

test('reports not_found when the topic was never discussed', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([
      { session: 's_a', at: NOW - DAY, turns: 5, topics: ['记忆架构'], gist: '要点' },
    ]),
  })
  await handler.handle(call({ query: '养猫' }))
  const output = lastOutput()
  assert.equal(output.status, 'not_found')
  assert.match(output.message, /养猫/)
})

test('separates an empty history from a missed topic', async () => {
  const { handler, lastOutput } = harness({ sessionDigests: digestPool() })
  await handler.handle(call({ query: '养猫' }))
  // 什么都没攒下时不该让用户以为自己记错了
  assert.equal(lastOutput().status, 'empty')
})

test('lists the most recent conversations when no topic is given', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([
      { session: 's_a', at: NOW - DAY, turns: 5, topics: ['甲'], gist: '要点甲' },
      { session: 's_b', at: NOW - 2 * DAY, turns: 6, topics: ['乙'], gist: '要点乙' },
    ]),
  })
  await handler.handle(call({}))
  const output = lastOutput()
  assert.equal(output.status, 'found')
  assert.equal(output.sessions.length, 2)
})

test('honours the requested limit', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool(
      Array.from({ length: 6 }, (_, index) => ({
        session: `s_${index}`,
        at: NOW - (index + 1) * DAY,
        turns: 5,
        topics: ['话题'],
        gist: '要点',
      })),
    ),
  })
  await handler.handle(call({ limit: 2 }))
  assert.equal(lastOutput().sessions.length, 2)
})

test('fails cleanly when session digests are not configured', async () => {
  const { handler, lastOutput } = harness()
  await handler.handle(call({ query: 'LOCOMO' }))
  const output = lastOutput()
  assert.equal(output.status, 'failed')
  // tool_unavailable 而不是我原先的 recall_unavailable：capability 不给时
  // registry 在分发之前就拦住了，方法体压根没进去。这比方法内自检更早，
  // 而且与 knowledge 等其他条件工具的行为一致 —— 工具没暴露就不该被调。
  assert.equal(output.error_code, 'tool_unavailable')
})

test('survives a throwing digest pool', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: { search() { throw new Error('磁盘挂了') }, count: () => 0 },
  })
  await handler.handle(call({ query: 'LOCOMO' }))
  const output = lastOutput()
  assert.equal(output.status, 'failed')
  assert.equal(output.error_code, 'recall_failed')
  assert.equal(output.retryable, true)
})

test('the tool is only exposed when session digests are enabled', () => {
  // 暴露与否由 registry 的 capability 策略决定，不再由 gateway 手工拼工具数组 ——
  // 手工拼会绕过策略过滤。capability 由 realtime-gateway 与 tool-call-handler
  // 用【同一个判据】给出（sessionDigests 存在），两处必须一致。
  const names = context => frontendTools(context).map(tool => tool.function.name)
  assert.ok(!names({}).includes(RECALL_TOOL_NAME))
  assert.ok(
    names({ frontend: { capabilities: [FRONTEND_RECALL_CAPABILITY] } })
      .includes(RECALL_TOOL_NAME),
  )
  // 与既有的条件工具互不干扰
  const both = names({
    frontend: { capabilities: [FRONTEND_RECALL_CAPABILITY] },
    client: { actions: ['desktop.presence.enter_sleep'] },
  })
  assert.ok(both.includes(RECALL_TOOL_NAME))
  assert.ok(both.includes('enter_sleep'))
})

test('the tool description points detail questions at the backend', () => {
  const [tool] = frontendTools({
    frontend: { capabilities: [FRONTEND_RECALL_CAPABILITY] },
  })
    .filter(item => item.function.name === RECALL_TOOL_NAME)
  // 「最多一层」的边界必须写在 description 里，否则模型会拿这几行当全部事实
  assert.match(tool.function.description, /get_agent_task_status/)
  // 资料检索归 knowledge 工具，description 要把模型指过去，否则它会拿 recall 硬试
  assert.match(tool.function.description, /knowledge/)
  assert.match(tool.function.description, /不含原话和执行细节|不要编造/)
  // 要细节全文时该改用哪个工具，也得写清楚，否则模型会拿这里的简写当结果
  assert.match(tool.function.description, /get_agent_task_status/)
})

// 用户不区分「聊过的」和「派过的活」，所以一次调用要都给到。
test('reports the work dispatched in a recalled session', async () => {
  const manager = new TaskManager()
  const task = manager.create({
    objective: '把压缩评测跑一遍',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: 'done', metadata: {} }),
  })
  const { handler, lastOutput } = harness({
    manager,
    sessionDigests: digestPool([{
      session: 's_a',
      at: NOW - 2 * DAY,
      turns: 8,
      topics: ['压缩评测'],
      gist: '让助手跑一轮',
      work: [{ id: task.id, objective: '把压缩评测跑一遍' }],
    }]),
  })
  await handler.handle(call({ query: '压缩评测' }))
  const [session] = lastOutput().sessions
  assert.equal(session.work.length, 1)
  assert.equal(session.work[0].objective, '把压缩评测跑一遍')
  // 状态是从台账实时读的，不是摘要里存的。这里不锁具体值 —— 任务在后台自行
  // 流转（queued → running → …），锁死取值会让测试跟调度时序赛跑。
  assert.notEqual(session.work[0].status, 'unknown', '应当从台账读到了状态')
  assert.ok(
    ['queued', 'running', 'delegated', 'finalizing', 'completed'].includes(
      session.work[0].status,
    ),
    `台账状态不在预期集合内：${session.work[0].status}`,
  )
})

test('falls back to unknown status once the task ledger has pruned the work', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([{
      session: 's_a',
      at: NOW - 60 * DAY,
      turns: 8,
      topics: ['老任务'],
      gist: '两个月前的事',
      // 台账终态只留 30 天，这个 id 早就查不到了
      work: [{ id: 'long-gone-task', objective: '很久以前那件事' }],
    }]),
  })
  await handler.handle(call({}))
  const [session] = lastOutput().sessions
  // 仍答得上「派过这件活」，只是给不出状态 —— 刻意的降级，不是错误
  assert.equal(session.work[0].objective, '很久以前那件事')
  assert.equal(session.work[0].status, 'unknown')
})

test('finds a session by the objective of the work it dispatched', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([{
      session: 's_a',
      at: NOW - DAY,
      turns: 5,
      topics: ['闲聊'],
      gist: '随便聊了聊',
      work: [{ id: 't1', objective: '整理季度报表' }],
    }]),
  })
  // 「季度报表」只出现在任务目标里，没进 topics 也没进 gist
  await handler.handle(call({ query: '季度报表' }))
  assert.equal(lastOutput().status, 'found')
})

test('omits the work field entirely when nothing was dispatched', async () => {
  const { handler, lastOutput } = harness({
    sessionDigests: digestPool([
      { session: 's_a', at: NOW - DAY, turns: 5, topics: ['纯聊天'], gist: '没派活' },
    ]),
  })
  await handler.handle(call({}))
  assert.equal('work' in lastOutput().sessions[0], false)
})
