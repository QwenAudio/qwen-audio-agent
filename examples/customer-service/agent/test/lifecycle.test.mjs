import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskState } from '@a2a-js/sdk'
import { ServiceAgentExecutor } from '../executor.mjs'
import { CustomerService } from '../../service/service.mjs'
import { toolDefinitions } from '../../service/tools/registry.mjs'

test('共享身份来自会话工具上下文而不是 objective，补充输入恢复原任务且不作为写入批准', async t => {
  const events = [], effects = [], captured = []
  let round = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-retail', policy: 'Authenticate the customer.',
        verifiedIdentity: { userId: 'customer', method: 'find_user_id_by_name_zip',
          arguments: { first_name: 'First', last_name: 'Last', zip: '12345' } } }),
      list: async () => [{ name: 'write', inputSchema: { type: 'object' } }],
      call: async (name, args) => {
        if (!args.approval_token) return { content: 'Preview only', data: {
          needsApproval: true, approval: { token: 'secret', preview: 'Approve this write?' } } }
        effects.push(name)
        return { content: 'Write committed' }
      },
    },
    model: { complete: async ({ messages }) => {
      captured.push(structuredClone(messages))
      round += 1
      if (round === 1) return { tool_calls: [{ id: 'question', function: {
        name: 'ask_customer', arguments: JSON.stringify({ question: 'Which payment method?' }) } }] }
      if (round === 2) return { tool_calls: [{ id: 'write', function: { name: 'write', arguments: '{}' } }] }
      return { content: 'Write committed' }
    } },
  })
  t.after(() => executor.reset())
  const run = (text, inputResponse, contextId = 'context') => executor.execute({
    taskId: 'task', contextId, task: inputResponse ? { id: 'task' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: text } }],
      metadata: inputResponse ? { qwenAudioInputResponse: inputResponse } : undefined },
  }, { publish: event => events.push(event) })
  await run('Exchange my item')
  assert.match(captured[0][0].content, /ALREADY been authenticated/)
  assert.match(captured[0][0].content, /12345/)
  assert.equal(executor.suspended.get('task').kind, 'customer-input')
  assert.ok(JSON.stringify(events).includes(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
  assert.ok(!JSON.stringify(events).includes(`"state":${TaskState.TASK_STATE_COMPLETED}`))
  await run('My card, yes', { kind: 'text', action: 'submit' })
  assert.equal(effects.length, 0, '补充输入即使含 yes 也不批准写入')
  assert.match(captured[1].at(-1).content, /NOT write authorization/)
  assert.equal(executor.suspended.get('task').operation.token, 'secret')
  await run('yes', { kind: 'authorization', action: 'accept' })
  assert.deepEqual(effects, ['write'])
  assert.match(JSON.stringify(events), /committed_operations=\\"1\\"/)
  assert.doesNotMatch(JSON.stringify(captured), /secret/)
})

test('没有提交的后台完成结果包含运行时回执，不能把模型声称成功当成提交证据', async () => {
  const events = []
  const executor = new ServiceAgentExecutor({
    tools: { context: async () => ({ toolset: 'tau-retail', policy: 'Policy' }),
      list: async () => [], call: async () => assert.fail() },
    model: { complete: async () => ({ content: 'Your exchange was submitted successfully.' }) },
  })
  await executor.execute({ taskId: 'task', contextId: 'context', userMessage: { parts: [] } },
    { publish: event => events.push(event) })
  assert.match(JSON.stringify(events), /committed_operations=\\"0\\"/)
  assert.match(JSON.stringify(events), /No data-changing operation was committed/)
})

test('补充输入的取消、错误上下文和过期都不恢复模型', async t => {
  for (const scenario of ['cancel', 'wrong-context', 'expired']) {
    let calls = 0
    const executor = new ServiceAgentExecutor({ tools: { list: async () => [], call: async () => assert.fail() },
      model: { complete: async () => {
        calls += 1
        return { tool_calls: [{ id: 'q', function: { name: 'ask_customer', arguments: '{"question":"Name?"}' } }] }
      } } })
    t.after(() => executor.reset())
    const run = resumed => executor.execute({ taskId: scenario,
      contextId: resumed && scenario === 'wrong-context' ? 'other' : 'context',
      task: resumed ? { id: scenario } : undefined,
      userMessage: { parts: [], metadata: resumed ? { qwenAudioInputResponse: {
        kind: 'text', action: scenario === 'cancel' ? 'cancel' : 'submit' } } : undefined },
    }, { publish() {} })
    await run(false)
    if (scenario === 'expired') executor.suspended.get(scenario).at -= 300_000
    await run(true)
    assert.equal(calls, 1)
    assert.equal(executor.suspended.size, 0)
  }
})

async function harness(t, options = {}) {
  const service = new CustomerService()
  await service.execute('verify_identity', { email: 'liming3021@example.com' }, { surface: 'frontend' })
  let modelCalls = 0
  const calls = []
  const tools = {
    list: async () => toolDefinitions('backend'),
    call: async (name, args) => {
      calls.push({ name, args })
      return service.execute(name, args, { surface: 'backend' })
    },
    revokeApproval: async token => service.revokeApproval('default', token),
  }
  const executor = new ServiceAgentExecutor({ tools, ...options, model: {
    complete: async ({ messages }) => {
      modelCalls += 1
      if (messages.at(-1).role === 'tool') return { content: messages.at(-1).content }
      return { tool_calls: [{ id: 'call', function: {
        name: 'cancel_order', arguments: JSON.stringify({ orderId: '#W1082334', reason: '不需要了' }),
      } }] }
    },
  } })
  t.after(() => executor.reset())
  const events = []
  const run = (taskId, { resumed = false, action, contextId = 'shared-context' } = {}) => executor.execute({
    taskId, contextId, task: resumed ? { id: taskId } : undefined,
    userMessage: {
      parts: [{ content: { $case: 'text', value: '取消订单' } }],
      metadata: action ? { qwenAudioInputResponse: { kind: 'authorization', action } } : undefined,
    },
  }, { publish: event => events.push(event) })
  const status = () => service.snapshot('default').db.orders.find(o => o.orderId === '#W1082334').status
  return { service, executor, calls, events, run, status, modelCalls: () => modelCalls }
}

for (const scenario of ['unknown-tool', 'invalid-json', 'missing-approval']) {
  test(`模型或工具返回非法数据时失败关闭：${scenario}`, async () => {
    let toolCalls = 0
    const executor = new ServiceAgentExecutor({
      tools: {
        list: async () => [{ name: 'write', inputSchema: { type: 'object' } }],
        call: async () => {
          toolCalls += 1
          return { content: '请确认', data: { needsApproval: true } }
        },
      },
      model: { complete: async () => ({ tool_calls: [{ id: 'call', function: {
        name: scenario === 'unknown-tool' ? 'not-registered' : 'write',
        arguments: scenario === 'invalid-json' ? '{broken' : '{}',
      } }] }) },
    })
    const events = []
    await executor.execute({ taskId: 'task', contextId: 'context', userMessage: { parts: [] } },
      { publish: event => events.push(event) })
    assert.equal(toolCalls, scenario === 'missing-approval' ? 1 : 0)
    assert.equal(executor.suspended.size, 0)
    assert.equal(executor.activeRuns.size, 0)
    // SDK 发布的是 AgentEvent 的 protobuf 包装，而不是裸 status 对象。
    assert.ok(JSON.stringify(events).includes(`"state":${TaskState.TASK_STATE_FAILED}`))
    const error = scenario === 'unknown-tool' ? /selected unknown tool/
      : scenario === 'invalid-json' ? /Invalid arguments/ : /Missing structured approval/
    assert.match(JSON.stringify(events), error)
  })
}

test('同上下文不同任务不会覆盖批准，接受后先提交保存的操作再整理结果', async t => {
  const h = await harness(t)
  await h.run('first')
  await h.run('second')
  assert.equal(h.executor.suspended.size, 2)
  const firstToken = h.executor.suspended.get('first').operation.token
  const secondToken = h.executor.suspended.get('second').operation.token
  await h.run('first', { resumed: true, action: 'decline' })
  assert.equal(h.service.store.mutable('default').pendingApprovals.has(firstToken), false)
  assert.equal(h.executor.suspended.has('second'), true)
  await h.run('second', { resumed: true, action: 'accept' })
  assert.equal(h.status(), 'cancelled')
  assert.equal(h.calls.at(-1).args.approval_token, secondToken)
  assert.equal(h.modelCalls(), 3, '批准操作先确定性提交，再由模型整理结果')
  assert.doesNotMatch(JSON.stringify(h.events), new RegExp(`${firstToken}|${secondToken}|approval_token`))
})

test('取消挂起任务会撤销令牌，旧任务不能再恢复或执行', async t => {
  const h = await harness(t)
  await h.run('task')
  const token = h.executor.suspended.get('task').operation.token
  await h.executor.cancelTask('task')
  assert.equal(h.executor.suspended.size, 0)
  assert.equal(h.service.store.mutable('default').pendingApprovals.has(token), false)
  await h.run('task', { resumed: true, action: 'accept' })
  assert.equal(h.modelCalls(), 1)
  assert.equal(h.status(), 'pending')
})

test('批准消息重放不会再次提交，也不会重新进入模型', async t => {
  const h = await harness(t)
  await h.run('task')
  await h.run('task', { resumed: true, action: 'accept' })
  const before = h.service.snapshot('default').db
  const calls = h.calls.length
  const modelCalls = h.modelCalls()
  await h.run('task', { resumed: true, action: 'accept' })
  assert.equal(h.calls.length, calls)
  assert.equal(h.modelCalls(), modelCalls)
  assert.deepEqual(h.service.snapshot('default').db, before)
})

test('模型后续提出第二笔操作，拒绝第二笔只撤销第二笔批准', async () => {
  const effects = []
  const revoked = []
  let modelCalls = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      list: async () => ['first', 'second'].map(name => ({ name, inputSchema: { type: 'object' } })),
      call: async (name, args) => {
        if (!args.approval_token) return { content: `确认 ${name}`, data: {
          needsApproval: true, approval: { token: `token-${name}`, preview: `确认 ${name}` },
        } }
        effects.push(name)
        return { content: `${name} 已执行` }
      },
      revokeApproval: async token => revoked.push(token),
    },
    model: { complete: async () => {
      modelCalls += 1
      const name = modelCalls === 1 ? 'first' : 'second'
      return { tool_calls: [{ id: name, function: { name, arguments: '{}' } }] }
    } },
  })
  const run = action => executor.execute({ taskId: 'task', contextId: 'context',
    task: action ? { id: 'task' } : undefined, userMessage: { parts: [],
      metadata: action ? { qwenAudioInputResponse: { kind: 'authorization', action } } : undefined },
  }, { publish() {} })
  try {
    await run()
    await run('accept')
    assert.deepEqual(effects, ['first'])
    assert.equal(executor.suspended.get('task').operation.name, 'second')
    await run('decline')
    assert.deepEqual(effects, ['first'])
    assert.deepEqual(revoked, ['token-second'])
    assert.equal(modelCalls, 2)
    assert.equal(executor.suspended.size, 0)
  } finally { await executor.reset() }
})

test('确认超时自动清理挂起任务和令牌', async t => {
  const h = await harness(t, { approvalTtlMs: 10 })
  await h.run('task')
  const token = h.executor.suspended.get('task').operation.token
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.executor.suspended.size, 0)
  assert.equal(h.service.store.mutable('default').pendingApprovals.has(token), false)
  await h.run('task', { resumed: true, action: 'accept' })
  assert.equal(h.status(), 'pending')
})

test('错误上下文不能使用同一任务的批准', async t => {
  const h = await harness(t)
  await h.run('task')
  await h.run('task', { resumed: true, action: 'accept', contextId: 'wrong-context' })
  assert.equal(h.status(), 'pending')
  assert.equal(h.modelCalls(), 1)
})

test('重置会取消运行中的模型请求并等待退出，不执行迟到的工具调用', async () => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let toolCalls = 0
  const events = []
  const executor = new ServiceAgentExecutor({
    tools: { list: async () => [{ name: 'write', inputSchema: { type: 'object' } }],
      call: async () => { toolCalls += 1 } },
    model: { complete: async () => {
      started.resolve()
      await release.promise
      return { tool_calls: [{ id: 'call', function: { name: 'write', arguments: '{}' } }] }
    } },
  })
  const running = executor.execute({ taskId: 'task', contextId: 'context', userMessage: { parts: [] } },
    { publish: event => events.push(event) })
  await started.promise
  const reset = executor.reset()
  assert.equal(executor.controllers.get('task').signal.aborted, true)
  release.resolve()
  await reset
  await running
  assert.equal(toolCalls, 0)
  assert.equal(executor.activeRuns.size, 0)
  assert.ok(JSON.stringify(events).includes(`"state":${TaskState.TASK_STATE_CANCELED}`))
})

test('一个任务多笔写操作逐笔批准，后续操作不会漏掉或提前执行，模型看不到令牌', async () => {
  const effects = []
  let modelCalls = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      list: async () => ['first', 'second'].map(name => ({ name, inputSchema: { type: 'object' } })),
      call: async (name, args) => {
        if (!args.approval_token) return { content: `确认 ${name}？`,
          data: { needsApproval: true, approval: { token: `private-${name}`, preview: `确认 ${name}？` } } }
        assert.equal(args.approval_token, `private-${name}`)
        effects.push(name)
        return { content: `${name} 已执行`, data: { changed: true } }
      },
    },
    model: { complete: async ({ messages }) => {
      modelCalls += 1
      assert.doesNotMatch(JSON.stringify(messages), /private-first|private-second/)
      if (messages.at(-1).role === 'tool') {
        assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['call-first', 'call-second'])
        return { content: '两笔操作均已完成。' }
      }
      return { tool_calls: ['first', 'second'].map(name => ({ id: `call-${name}`,
        function: { name, arguments: '{}' } })) }
    } },
  })
  const events = []
  const run = resumed => executor.execute({
    taskId: 'task', contextId: 'context', task: resumed ? { id: 'task' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: resumed ? '同意' : '办理两笔操作' } }],
      metadata: resumed ? { qwenAudioInputResponse: { kind: 'authorization', action: 'accept' } } : undefined },
  }, { publish: event => events.push(event) })
  await run(false)
  assert.deepEqual(effects, [])
  await run(true)
  assert.deepEqual(effects, ['first'])
  assert.equal(executor.suspended.get('task').operation.name, 'second')
  assert.equal(executor.suspended.get('task').objective, '办理两笔操作')
  await run(true)
  assert.deepEqual(effects, ['first', 'second'])
  assert.equal(executor.suspended.size, 0)
  assert.equal(modelCalls, 2)
  assert.doesNotMatch(JSON.stringify(events), /private-first|private-second/)
})
