import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskState } from '@a2a-js/sdk'
import { ServiceAgentExecutor, serviceAgentPrompt } from '../executor.mjs'
import { CustomerService } from '../../service/service.mjs'
import { toolDefinitions } from '../../service/tools/registry.mjs'

test('完整写入参数直接走精确预览授权，不先创建普通补充输入请求', async t => {
  const events = [], calls = [], modelInputs = []
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-test', policy: 'Require customer approval before writes.' }),
      list: async () => [{ name: 'write', inputSchema: { type: 'object', properties: {} } }],
      call: async (_name, args) => {
        calls.push(args)
        return args.approval_token
          ? { content: 'Committed', data: { operationCommitted: true } }
          : { content: 'Preview', data: { needsApproval: true,
            approval: { token: 'private-token', preview: 'Approve exact write?' } } }
      },
    },
    model: { complete: async input => {
      modelInputs.push(input)
      return modelInputs.length === 1
        ? { tool_calls: [{ id: 'write-call', function: { name: 'write', arguments: '{}' } }] }
        : { content: 'Committed' }
    } },
  })
  t.after(() => executor.reset())
  const run = (resumed = false) => executor.execute({ taskId: 'one-confirmation', contextId: 'context',
    task: resumed ? { id: 'one-confirmation' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: resumed ? 'yes' : 'Please update it' } }],
      metadata: resumed ? { qwenAudioInputResponse: { kind: 'authorization', action: 'accept' } } : undefined },
  }, { publish: event => events.push(event) })
  await run()
  assert.match(modelInputs[0].messages[0].content, /do not first ask a generic/)
  assert.match(modelInputs[0].tools.at(-1).function.description, /cannot authorize a write/)
  assert.equal(calls.length, 1)
  assert.equal(executor.suspended.get('one-confirmation').operation.token, 'private-token')
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_AUTH_REQUIRED}`))
  await run(true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].approval_token, 'private-token')
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
})

test('用户已明确批准的组合方案可覆盖多个依赖写操作', async t => {
  const events = [], calls = [], decisions = []
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-eva_airline', policy: 'Follow airline policy.' }),
      list: async () => ['rebook_flight', 'assign_seat'].map(name => ({
        name, inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false },
      })),
      call: async (name, args) => {
        calls.push({ name, args })
        return args.approval_token
          ? { content: JSON.stringify({ status: 'success', operation: name }),
            data: { operationCommitted: true } }
          : { content: `Preview ${name}`, data: { needsApproval: true,
            approval: { token: `token-${name}`, preview: `Preview ${name}` } } }
      },
    },
    model: {
      complete: async ({ messages }) => messages.some(message => message.role === 'tool')
        ? { content: 'Rebooked and assigned seat 21A.' }
        : { tool_calls: [{ id: 'rebook', function: {
          name: 'rebook_flight', arguments: JSON.stringify({ flight: 'SK703', cost: 115 }),
        } }, { id: 'seat', function: {
          name: 'assign_seat', arguments: JSON.stringify({ preference: 'window' }),
        } }] },
      authorizePriorPlan: async input => {
        decisions.push(input)
        return { authorized: true, reason: 'covered by the approved combined proposal' }
      },
    },
  })
  t.after(() => executor.reset())

  await executor.execute({ taskId: 'combined-plan', contextId: 'context',
    userMessage: {
      parts: [{ content: { $case: 'text', value: 'Rebook and assign the requested window seat.' } }],
      metadata: { qwenAudioAuthorizationEvidence: {
        proposal: 'Rebook to SK703 for $115, then assign a window seat. Shall I proceed?',
        customerReply: 'Go ahead, and assign a window seat.',
      } },
    },
  }, { publish: event => events.push(event) })

  assert.deepEqual(calls.map(call => [call.name, call.args.approval_token || null]), [
    ['rebook_flight', null], ['rebook_flight', 'token-rebook_flight'],
    ['assign_seat', null], ['assign_seat', 'token-assign_seat'],
  ])
  assert.equal(decisions.length, 2)
  assert.equal(executor.suspended.has('combined-plan'), false)
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_AUTH_REQUIRED}`))
  assert.match(JSON.stringify(events), /Rebooked and assigned seat 21A/)
})

test('后台按前台模型的结构化 accept 提交，不再用文本规则二次分类', async t => {
  const writes = [], revoked = []
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-retail', policy: 'Approval required.' }),
      list: async () => [{ name: 'return_item', inputSchema: { type: 'object', properties: {} } }],
      call: async (_name, args) => {
        writes.push(args)
        return args.approval_token
          ? { content: 'Committed', data: { operationCommitted: true } }
          : { content: 'Preview', data: { needsApproval: true,
            approval: { token: 'old-preview', preview: 'Return cheaper item to credit card?' } } }
      },
      revokeApproval: async token => revoked.push(token),
    },
    model: { complete: async ({ messages }) => messages.some(message => message.role === 'tool')
      ? { content: 'Committed' }
      : { tool_calls: [{ id: 'write', function: {
        name: 'return_item', arguments: '{}',
      } }] } },
  })
  t.after(() => executor.reset())
  const events = []
  const run = (text, resumed = false) => executor.execute({ taskId: 'changed-request', contextId: 'context',
    task: resumed ? { id: 'changed-request' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: text } }],
      metadata: resumed ? { qwenAudioInputResponse: { kind: 'authorization', action: 'accept' } } : undefined },
  }, { publish: event => events.push(event) })
  await run('Return the cheaper item to my credit card')
  await run('No, return the more expensive item to a gift card instead', true)
  assert.equal(writes.length, 2)
  assert.equal(writes[1].approval_token, 'old-preview')
  assert.deepEqual(revoked, [])
  assert.match(JSON.stringify(events), /Committed/)
})

test('两个客服域都把运行时精确预览作为写操作的唯一最终确认', () => {
  for (const domain of ['retail', 'airline']) {
    assert.match(serviceAgentPrompt(domain), /预览后的运行时授权就是该具体操作的最终确认/)
    assert.match(serviceAgentPrompt(domain), /不要先单独询问一次/)
    assert.match(serviceAgentPrompt(domain), /任何一笔都不要先提交/)
    assert.match(serviceAgentPrompt(domain), /旧偏好不能代替本次明确[\s\S]*答复/)
    assert.match(serviceAgentPrompt(domain), /已发起.*不等于.*已到账/s)
    assert.match(serviceAgentPrompt(domain), /多组成结果必须逐笔调用/)
    assert.match(serviceAgentPrompt(domain), /不得重复询问/)
  }
})

test('官方 policy 后的执行说明包含冲突预检、完成清单和最终状态核验', async t => {
  let systemPrompt
  const executor = new ServiceAgentExecutor({
    tools: { context: async () => ({ toolset: 'tau-retail', policy: 'Authoritative policy.' }),
      list: async () => [], call: async () => assert.fail('No tool call expected') },
    model: { complete: async ({ messages }) => {
      systemPrompt = messages[0].content
      return { content: 'No changes made.' }
    } },
  })
  t.after(() => executor.reset())
  await executor.execute({ taskId: 'multi-action-policy', contextId: 'context',
    userMessage: { parts: [{ content: { $case: 'text', value: 'Return and exchange in one order' } }] },
  }, { publish() {} })
  assert.match(systemPrompt, /Before the FIRST write in a multi-action request/)
  assert.match(systemPrompt, /do not commit either one or silently perform only a subset/)
  assert.match(systemPrompt, /use ask_customer for a genuine choice/)
  assert.match(systemPrompt, /preserve-by-default fields, and unresolved items as a completion checklist/)
  assert.match(systemPrompt, /continue until every requested outcome is completed/)
  assert.match(systemPrompt, /use available read tools to verify the changed records/)
  assert.match(systemPrompt, /Policy-required record confirmation and fresh preference are required facts/)
  assert.match(systemPrompt, /stored preference is not a fresh answer/)
  assert.match(systemPrompt, /MUST NOT be asked again/)
  assert.match(systemPrompt, /initiated, pending, or processing never means received/)
  assert.match(systemPrompt, /execute every policy-required component separately/)
})

test('同一零售订单的互斥诉求在写预览前先请客户选择，泛化 yes 不能越过门禁', async t => {
  const events = [], writes = []
  let rounds = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-retail', policy: 'Both actions require delivered status.' }),
      list: async () => ['return_delivered_order_items', 'exchange_delivered_order_items'].map(name => ({
        name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false },
      })),
      call: async (name, args) => {
        writes.push({ name, args })
        return args.approval_token
          ? { content: 'Committed', data: { operationCommitted: true } }
          : { content: 'Preview', data: { needsApproval: true,
            approval: { token: 'exchange-token', preview: 'Approve exchange?' } } }
      },
    },
    model: { complete: async () => {
      rounds += 1
      return rounds === 1
        ? { tool_calls: [{ id: 'exchange', function: {
          name: 'exchange_delivered_order_items', arguments: '{"order_id":"#W123"}',
        } }] }
        : { content: 'Exchange completed' }
    } },
  })
  t.after(() => executor.reset())
  const run = (answer, action) => executor.execute({ taskId: 'mutually-exclusive', contextId: 'context',
    task: answer ? { id: 'mutually-exclusive' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: answer || 'Return and exchange items in order #W123' } }],
      metadata: action ? { qwenAudioInputResponse: { kind: 'authorization', action } } : undefined },
  }, { publish: event => events.push(event) })
  await run()
  assert.equal(rounds, 0)
  assert.equal(writes.length, 0)
  assert.equal(executor.suspended.get('mutually-exclusive').choiceRequest, true)
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
  await run('yes')
  assert.equal(rounds, 0)
  assert.equal(writes.length, 0)
  await run('exchange')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].name, 'exchange_delivered_order_items')
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_AUTH_REQUIRED}`))
  await run('yes', 'accept')
  assert.equal(writes.length, 2)
  assert.equal(writes[1].args.approval_token, 'exchange-token')
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_COMPLETED}`))
})

test('选择换货后运行时拒绝模型改走退货写工具', async t => {
  const events = []
  let writes = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-retail', policy: 'Both require delivered.' }),
      list: async () => [{ name: 'return_delivered_order_items', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false } }],
      call: async () => { writes += 1; throw new Error('Wrong write reached service') },
    },
    model: { complete: async () => ({ tool_calls: [{ id: 'wrong', function: {
      name: 'return_delivered_order_items', arguments: '{"order_id":"#W123"}',
    } }] }) },
  })
  t.after(() => executor.reset())
  const run = answer => executor.execute({ taskId: 'selected-only', contextId: 'context',
    task: answer ? { id: 'selected-only' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: answer || 'Return and exchange items in order #W123' } }] },
  }, { publish: event => events.push(event) })
  await run()
  await run('exchange')
  assert.equal(writes, 0)
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_FAILED}`))
})

test('客户只选择一笔订单后不能用同类写工具改动另一笔订单', async t => {
  const events = []
  let writes = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      context: async () => ({ toolset: 'tau-retail', policy: 'Both require delivered.' }),
      list: async () => [{ name: 'exchange_delivered_order_items', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false } }],
      call: async () => { writes += 1; throw new Error('Wrong order reached service') },
    },
    model: { complete: async () => ({ tool_calls: [{ id: 'wrong-order', function: {
      name: 'exchange_delivered_order_items', arguments: '{"order_id":"#W999"}',
    } }] }) },
  })
  t.after(() => executor.reset())
  const run = answer => executor.execute({ taskId: 'selected-order-only', contextId: 'context',
    task: answer ? { id: 'selected-order-only' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: answer || 'Return and exchange items in order #W123' } }] },
  }, { publish: event => events.push(event) })
  await run()
  await run('exchange')
  assert.equal(writes, 0)
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_FAILED}`))
})

test('互斥门禁不误拦不同订单或航空任务', async t => {
  for (const [toolset, objective] of [
    ['tau-retail', 'Return item in #W123 and exchange item in #W999'],
    ['tau-airline', 'Return and exchange options for reservation #W123'],
  ]) {
    const events = []
    let rounds = 0
    const executor = new ServiceAgentExecutor({
      tools: { context: async () => ({ toolset, policy: 'Policy.' }), list: async () => [],
        call: async () => assert.fail('No tool call expected') },
      model: { complete: async () => { rounds += 1; return { content: 'Investigating.' } } },
    })
    t.after(() => executor.reset())
    await executor.execute({ taskId: `scope-${toolset}`, contextId: 'context',
      userMessage: { parts: [{ content: { $case: 'text', value: objective } }] },
    }, { publish: event => events.push(event) })
    assert.equal(rounds, 1)
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
  }
})

test('补充输入协议拒绝第三种泛化确认，也不把它变成客户授权', async () => {
  for (const args of [
    { purpose: 'authorization', question: 'May I proceed?' },
    { purpose: 'missing_information', question: 'Which card?' },
    { purpose: 'business_choice', question: 'Which option?', options: ['Same', 'Same'] },
  ]) {
    const events = []
    const executor = new ServiceAgentExecutor({
      tools: { list: async () => [], call: async () => assert.fail('No write may run') },
      model: { complete: async () => ({ tool_calls: [{ id: 'question', function: {
        name: 'ask_customer', arguments: JSON.stringify(args),
      } }] }) },
    })
    await executor.execute({ taskId: 'invalid-input', contextId: 'context',
      userMessage: { parts: [{ content: { $case: 'text', value: 'Please update it' } }] },
    }, { publish: event => events.push(event) })
    assert.equal(executor.suspended.size, 0)
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
    assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_FAILED}`))
  }
})

test('模型的补充输入参数无效时收到工具错误并可修正，不直接使任务失败', async t => {
  const events = []
  let rounds = 0
  const executor = new ServiceAgentExecutor({
    tools: { list: async () => [], call: async () => assert.fail('No write may run') },
    model: { complete: async ({ messages }) => {
      rounds += 1
      if (rounds === 2) assert.match(messages.at(-1).content, /ask_customer rejected: Business-choice request requires distinct options/)
      return { tool_calls: [{ id: `question-${rounds}`, function: {
        name: 'ask_customer', arguments: JSON.stringify(rounds === 1
          ? { purpose: 'business_choice', question: 'Which refund method?', options: ['Card'] }
          : { purpose: 'business_choice', question: 'Which refund method?', options: ['Original card', 'Gift card'] }),
      } }] }
    } },
  })
  t.after(() => executor.reset())
  await executor.execute({ taskId: 'repair-customer-input', contextId: 'context',
    userMessage: { parts: [{ content: { $case: 'text', value: 'Please process my return' } }] },
  }, { publish: event => events.push(event) })
  assert.equal(rounds, 2)
  assert.equal(executor.suspended.get('repair-customer-input').kind, 'customer-input')
  assert.match(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_INPUT_REQUIRED}`))
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`"state":${TaskState.TASK_STATE_FAILED}`))
})

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
        name: 'ask_customer', arguments: JSON.stringify({ purpose: 'missing_information',
          field: 'payment_method_id', question: 'Which payment method?' }) } }] }
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
  assert.match(JSON.stringify(events), /"outcome":"committed"/)
  assert.match(JSON.stringify(events), /"committedCount":1/)
  assert.match(JSON.stringify(events), /"operation":"write"/)
  assert.doesNotMatch(JSON.stringify(events), /execution_receipt committed_operations/)
  assert.doesNotMatch(JSON.stringify(captured), /secret/)
})

test('没有提交的后台完成结果包含结构化运行时回执，不能把模型声称成功当成提交证据', async () => {
  const events = []
  const executor = new ServiceAgentExecutor({
    tools: { context: async () => ({ toolset: 'tau-retail', policy: 'Policy' }),
      list: async () => [], call: async () => assert.fail() },
    model: { complete: async () => ({ content: 'Your exchange was submitted successfully.' }) },
  })
  await executor.execute({ taskId: 'task', contextId: 'context', userMessage: { parts: [] } },
    { publish: event => events.push(event) })
  assert.match(JSON.stringify(events), /"outcome":"no_change"/)
  assert.match(JSON.stringify(events), /"committedCount":0/)
  assert.match(JSON.stringify(events), /"committedOperations":\[\]/)
  assert.match(JSON.stringify(events), /No data-changing operation was committed/)
  assert.doesNotMatch(JSON.stringify(events), /execution_receipt committed_operations/)
})

test('已提交工具的 JSON 结果以结构化事实进入回执，不截成自然语言片段', async t => {
  const events = []
  let modelCalls = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      list: async () => [{ name: 'write', inputSchema: { type: 'object' } }],
      call: async (_name, args) => args.approval_token
        ? { content: JSON.stringify({ status: 'success', refund_id: 'REF-1', amount: 218.4 }),
          data: { operationCommitted: true } }
        : { content: 'Preview', data: { needsApproval: true,
          approval: { token: 'private-token', preview: 'Approve write?' } } },
    },
    model: { complete: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? { tool_calls: [{ id: 'write', function: { name: 'write', arguments: '{}' } }] }
        : { content: 'Done' }
    } },
  })
  t.after(() => executor.reset())
  const run = resumed => executor.execute({
    taskId: 'structured-result', contextId: 'context',
    task: resumed ? { id: 'structured-result' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: resumed ? 'yes' : 'update' } }],
      metadata: resumed ? { qwenAudioInputResponse: { kind: 'authorization', action: 'accept' } } : undefined },
  }, { publish: event => events.push(event) })
  await run(false)
  await run(true)
  const receipt = events.flatMap(event => event.data?.artifact?.parts || [])
    .find(part => part.content?.value?.schema === 'qwen-audio-agent/customer-service-execution-receipt@1')
    ?.content.value
  assert.deepEqual(receipt.committedOperations[0].result,
    { status: 'success', refund_id: 'REF-1', amount: 218.4 })
  assert.equal(receipt.committedOperations[0].summary, undefined)
})

test('提交一笔后后续失败时，结构化回执保留已提交操作并标记 partial', async t => {
  const events = []
  let modelCalls = 0
  const executor = new ServiceAgentExecutor({
    tools: {
      list: async () => [{ name: 'write', inputSchema: { type: 'object' } }],
      call: async (_name, args) => args.approval_token
        ? { content: 'Write committed', data: { operationCommitted: true } }
        : { content: 'Preview', data: { needsApproval: true,
          approval: { token: 'private-token', preview: 'Approve write?' } } },
    },
    model: { complete: async () => {
      modelCalls += 1
      if (modelCalls === 1) return { tool_calls: [{ id: 'write', function: {
        name: 'write', arguments: '{}',
      } }] }
      throw new Error('Follow-up planning failed')
    } },
  })
  t.after(() => executor.reset())
  const run = resumed => executor.execute({
    taskId: 'partial-task', contextId: 'context', task: resumed ? { id: 'partial-task' } : undefined,
    userMessage: { parts: [{ content: { $case: 'text', value: resumed ? 'yes' : 'update' } }],
      metadata: resumed ? { qwenAudioInputResponse: { kind: 'authorization', action: 'accept' } } : undefined },
  }, { publish: event => events.push(event) })
  await run(false)
  await run(true)
  const serialized = JSON.stringify(events)
  assert.match(serialized, /"outcome":"partial"/)
  assert.match(serialized, /"committedCount":1/)
  assert.match(serialized, /"operation":"write"/)
  assert.match(serialized, new RegExp(`"state":${TaskState.TASK_STATE_FAILED}`))
})

test('补充输入的取消、错误上下文和过期都不恢复模型', async t => {
  for (const scenario of ['cancel', 'wrong-context', 'expired']) {
    let calls = 0
    const executor = new ServiceAgentExecutor({ tools: { list: async () => [], call: async () => assert.fail() },
      model: { complete: async () => {
        calls += 1
        return { tool_calls: [{ id: 'q', function: { name: 'ask_customer', arguments: JSON.stringify({
          purpose: 'missing_information', field: 'name', question: 'Name?',
        }) } }] }
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
      parts: [{ content: { $case: 'text', value: resumed ? action === 'accept' ? '同意' : '拒绝' : '取消订单' } }],
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
    task: action ? { id: 'task' } : undefined, userMessage: { parts: action
      ? [{ content: { $case: 'text', value: action === 'accept' ? '同意' : '拒绝' } }]
      : [],
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
  assert.match(JSON.stringify(events), /"committedCount":2/)
  assert.match(JSON.stringify(events), /"operation":"first"/)
  assert.match(JSON.stringify(events), /"operation":"second"/)
})
