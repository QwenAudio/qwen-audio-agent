import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { serviceAgentPrompt, ServiceAgentExecutor } from '../executor.mjs'
import {
  A2ABackendAdapter,
} from '../../../../server/src/backend/adapters/a2a/backend-adapter.mjs'
import { startCustomerServiceServer } from '../../service/server.mjs'
import { CustomerService } from '../../service/service.mjs'
import { startServiceAgentServer } from '../server.mjs'

// 【这组测试的目的】auth_required 这条链在 realtime 侧代码是接通的，
// 但座舱示例用不到它（开天窗不需要客户批准），所以可能从没被真实跑过。
// 这里用真实的 A2ABackendAdapter 对接真实的 A2A Agent，把整条链走一遍：
//
//   工具返回 needsApproval
//     → executor 发 TASK_STATE_AUTH_REQUIRED + 预览消息
//     → adapter 转成 kind='authorization' 的 InputRequest 并挂起
//     → 我们代替前台调 respondInput
//     → 后台带上客户答复继续
//
// 模型用桩：这里要验证的是协议链路，不是模型的判断力。
// 真实模型的行为另有 runtime 探针覆盖。

function toolCall(name, args) {
  return {
    content: null,
    tool_calls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
  }
}

// 故意会利用文本里的令牌的桩模型；运行时不得把真实令牌交给它。
function cancelModel() {
  return {
    async complete({ messages }) {
      const last = messages.at(-1)
      const token = last.content?.match?.(/approval_token="([^"]+)"/)?.[1]
      if (token) {
        return toolCall('cancel_order', {
          orderId: '#W1082334', reason: '不需要了', approval_token: token,
        })
      }
      if (last.role === 'tool') return { content: last.content }
      return toolCall('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
    },
  }
}

test('缺少结构化批准时，即使文本说同意也不进入模型', async () => {
  let modelCalls = 0
  const executor = new ServiceAgentExecutor({
    tools: { list: async () => [], call: async () => assert.fail('不应调用工具') },
    model: { complete: async () => { modelCalls += 1; assert.fail('不应调用模型') } },
  })
  executor.suspended.set('task', { contextId: 'context', objective: '取消订单', preview: '待确认', at: Date.now() })
  const events = []
  await executor.execute({
    taskId: 'task', contextId: 'context', task: { id: 'task' },
    userMessage: { parts: [{ content: { $case: 'text', value: '同意' } }] },
  }, { publish: event => events.push(event) })
  assert.equal(modelCalls, 0)
  assert.equal(executor.suspended.size, 0)
  assert.ok(events.length > 0)
})

// 【用事件回调等待，不要轮询】最初写成 setTimeout 轮询 seen 数组，
// 结果整个测试挂住不动：submit 没被 await，轮询又持续占着事件循环，
// 后台任务推不下去。改成在 subscribe 回调里直接兑现 Promise。
function pendingInput(backend, seen, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('30 秒内没有收到 pending 的 InputRequest')), 30_000)
    const unsubscribe = backend.subscribe(event => {
      seen.push(event)
      if (event.input?.status === 'pending') {
        clearTimeout(timer)
        resolve(event.input)
      }
    })
    t.after(unsubscribe)
  })
}

async function harness(t, model, domain = 'retail') {
  const service = new CustomerService()
  // 先核验身份：写库工具在未核验时会拒绝，那条已有单测覆盖，
  // 这里要测的是批准链路，所以把前置条件摆好。
  await service.execute('verify_identity', domain === 'airline'
    ? { memberId: 'CY10023841' } : { email: 'liming3021@example.com' },
    { sessionId: 'default', surface: 'frontend', domain })

  const http = await startCustomerServiceServer({ service, port: 0 })
  t.after(() => http.close())
  const agent = await startServiceAgentServer({
    port: 0, serviceOrigin: http.origin, model,
  })
  t.after(() => agent.close())
  const backend = new A2ABackendAdapter({
    agentCardUrl: agent.agentCardUrl,
    pollIntervalMs: 10,
  })
  t.after(() => backend.close())
  return { service, backend, agent }
}

if (process.env.CS_DOMAIN !== 'airline') {
  test('独立航空进程验证实际 MCP/A2A 部署的接受与拒绝链路', async () => {
    const env = { ...process.env, CS_DOMAIN: 'airline' }
    delete env.NODE_TEST_CONTEXT
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern=航空取消预订', fileURLToPath(import.meta.url)],
      { env, timeout: 45_000 })
    assert.match(stdout, /# pass 2/)
    assert.match(stdout, /# fail 0/)
  })
}

for (const action of process.env.CS_DOMAIN === 'airline' ? ['accept', 'decline'] : []) {
  test(`航空取消预订走真实 MCP/A2A 确认链路：${action}`, async t => {
    const { service, backend } = await harness(t, {
      complete: async ({ messages }) => messages.at(-1).role === 'tool'
        ? { content: messages.at(-1).content }
        : toolCall('cancel_reservation', { reservationId: 'CYR8801', reason: '不需要了' }),
    }, 'airline')
    const waiting = pendingInput(backend, [], t)
    const running = backend.submit({ id: `air-${action}`, ownerId: 'owner', objective: '取消预订 CYR8801' })
    const input = await waiting
    assert.equal(input.kind, 'authorization')
    assert.doesNotMatch(input.prompt, /approval_token/)
    const before = service.snapshot('default').db
    await backend.respondInput(`air-${action}`, input.id, { action })
    await running
    const after = service.snapshot('default').db
    if (action === 'decline') assert.deepEqual(after, before)
    else assert.equal(after.reservations.find(r => r.reservationId === 'CYR8801').status, 'cancelled')
  })
}

test('后台 Agent 用完整工具面（含写库工具）', async t => {
  const { agent } = await harness(t, cancelModel())
  const names = (await agent.executor.tools.list()).map(tool => tool.name)
  for (const wanted of ['cancel_order', 'return_items', 'modify_address', 'transfer_to_human']) {
    assert.ok(names.includes(wanted), `后台面缺 ${wanted}`)
  }
})

test('需要批准时任务挂起为 auth_required，预览进 InputRequest', async t => {
  const { service, backend } = await harness(t, cancelModel())
  const seen = []
  const waitingForInput = pendingInput(backend, seen, t)

  // submit 会一直等到任务结束（挂起期间它不返回），所以这里不能 await 它。
  const running = backend.submit({
    id: 'gateway-task-auth', ownerId: 'owner',
    objective: '帮客户取消订单 #W1082334，原因是不需要了',
  })
  const input = await waitingForInput

  // 【核心断言】kind 必须是 authorization，而不是普通的 input
  assert.equal(input.kind, 'authorization')
  assert.equal(input.status, 'pending')
  // 预览原文要一路传到 InputRequest，金额不能在中途丢失
  assert.match(input.prompt, /将取消订单 #W1082334/)
  assert.match(input.prompt, /￥899\.00/)
  assert.doesNotMatch(input.prompt, /approval_token|以上内容需要|再调用/)

  // 挂起期间数据库不能有变化
  assert.equal(
    service.snapshot('default').db.orders.find(o => o.orderId === '#W1082334').status,
    'pending',
    '挂起期间订单不该被改动',
  )

  // 代替前台把客户的「同意」送回去
  await backend.respondInput('gateway-task-auth', input.id, { action: 'accept', text: '客户说可以' })

  const output = await running
  assert.match(output.content, /已取消/)
  assert.equal(
    service.snapshot('default').db.orders.find(o => o.orderId === '#W1082334').status,
    'cancelled',
  )
})

test('客户拒绝时不执行，任务照常收尾', async t => {
  const model = cancelModel()
  let modelCalls = 0
  const { service, backend } = await harness(t, {
    async complete(request) {
      modelCalls += 1
      // 若恢复后仍进入模型，这个桩会无视拒绝并用令牌取消订单。
      return model.complete(request)
    },
  })
  const seen = []
  const waitingForInput = pendingInput(backend, seen, t)

  const running = backend.submit({
    id: 'gateway-task-decline', ownerId: 'owner',
    objective: '帮客户取消订单 #W1082334，原因是不需要了',
  })
  const input = await waitingForInput
  const callsBeforeDecline = modelCalls
  // 结构化 action 必须优先于文本，不能被“同意”字样覆盖。
  await backend.respondInput('gateway-task-decline', input.id, { action: 'decline', text: '同意取消订单' })

  const output = await running
  assert.ok(output.content)
  assert.equal(modelCalls, callsBeforeDecline, '拒绝后不得再次调用模型')
  // 【最关键的一条】拒绝之后订单必须保持原样
  assert.equal(
    service.snapshot('default').db.orders.find(o => o.orderId === '#W1082334').status,
    'pending',
    '客户拒绝后订单不该被取消',
  )
  const resolved = seen.find(event => event.input?.status === 'declined')
  assert.ok(resolved, '应发出 INPUT_RESOLVED(declined)')
})

test('不需要批准的操作直接完成，不会挂起', async t => {
  const { backend } = await harness(t, {
    async complete({ messages }) {
      const last = messages.at(-1)
      if (last.role === 'tool') return { content: last.content }
      return toolCall('transfer_to_human', { reason: '客户明确要求人工' })
    },
  })
  const seen = []
  const unsubscribe = backend.subscribe(event => seen.push(event))
  t.after(unsubscribe)
  const output = await backend.submit({
    id: 'gateway-task-plain', ownerId: 'owner', objective: '客户要求转人工',
  })
  assert.match(output.content, /转接/)
  assert.equal(
    seen.filter(event => event.input?.status === 'pending').length, 0,
    '转人工不该触发批准挂起',
  )
})

test('工具的业务拒绝直接返回，不走批准流程', async t => {
  const { service, backend } = await harness(t, {
    async complete({ messages }) {
      const last = messages.at(-1)
      if (last.role === 'tool') return { content: last.content }
      // #W2378156 里的恒温器是家电，签收已 22 天，超出 15 天窗口
      return toolCall('return_items', { orderId: '#W2378156', itemIds: ['TH_HOMEKIT'] })
    },
  })
  const seen = []
  const unsubscribe = backend.subscribe(event => seen.push(event))
  t.after(unsubscribe)
  const output = await backend.submit({
    id: 'gateway-task-expired', ownerId: 'owner', objective: '客户要退恒温器',
  })
  assert.match(output.content, /超出退货时限/)
  assert.equal(
    seen.filter(event => event.input?.status === 'pending').length, 0,
    '被业务规则拒绝的操作不该请求批准',
  )
  assert.equal(
    service.snapshot('default').db.orders.find(o => o.orderId === '#W2378156').returnedItemIds,
    undefined,
  )
})

// ── 后台 Agent 的 prompt 必须域无关 ──

test('prompt 里的业务名字跟着 CS_DOMAIN 走', () => {
  // 【这条守着一个实测发现的遗漏】
  // 第一版 prompt 写死「你是零售客服的后台 Agent」，而工具面是从
  // /mcp/backend 动态拉的（service 按域挑）—— 航空组起来之后
  // 工具对、话术全说错了域。那种错不报任何异常。
  assert.match(serviceAgentPrompt('retail'), /零售客服/)
  assert.match(serviceAgentPrompt('airline'), /航空客服/)
  // 未知域退化成中性说法，不要抛错 —— 加第三个域时不该先炸在这里
  assert.match(serviceAgentPrompt('hotel'), /客服的后台 Agent/)
})

function basePrompt(domain) {
  return serviceAgentPrompt(domain).split('\n\n管理员配置的流程约束：')[0]
}

test('基础 prompt 不列举任何域特定的工具名', () => {
  // 域特定的顺序现在可以由管理员写进 flows.json；基础规则仍不能列举工具，
  // 否则加新域时又会回到「工具对、固定 prompt 错」的问题。
  for (const domain of ['retail', 'airline']) {
    const prompt = basePrompt(domain)
    for (const name of [
      'cancel_order', '取消订单', '退货', '改地址', '款式库存',
      'cancel_reservation', '退票', '改签', '加行李',
    ]) {
      assert.ok(!prompt.includes(name),
        `${domain} 的基础 prompt 里出现了域特定的工具名「${name}」`)
    }
  }
})

test('基础 prompt 不抄工具的判定话术', () => {
  // flows 只管顺序，可以提业务动作；资格与结果仍由工具返回，基础规则不能抄。
  for (const domain of ['retail', 'airline']) {
    const prompt = basePrompt(domain)
    for (const phrase of [
      '超出退货时限', '未发货状态', '已有航段执飞', '特价经济舱不可改签',
    ]) {
      assert.ok(!prompt.includes(phrase),
        `基础 prompt 抄了工具的判定话术「${phrase}」—— 工具改了它就不一致`)
    }
  }
})

test('prompt 说明运行时负责两段式批准，而不是让模型填写令牌', () => {
  const prompt = serviceAgentPrompt('airline')
  assert.match(prompt, /approval_token/)
  // 批准机制由运行时驱动，加新工具不用把工具名写进 prompt。
  assert.match(prompt, /明确批准后由运行时提交保存的操作/)
  assert.match(prompt, /不要自己填写 approval_token/)
})

test('两个域的基础 prompt 只差业务名字，流程由配置产生差异', () => {
  const normalize = text => text.replace(/零售客服|航空客服/g, '「域」')
  assert.equal(normalize(basePrompt('retail')), normalize(basePrompt('airline')))
  assert.match(serviceAgentPrompt('retail'), /复述新地址/)
  assert.match(serviceAgentPrompt('airline'), /愿意升舱/)
  assert.notEqual(serviceAgentPrompt('retail'), serviceAgentPrompt('airline'))
})

test('基础 prompt 明令不得向客户暴露内部结构', () => {
  // 【实测撞到的】客户要退票，后台 Agent 汇报里说「我需要提交后台客服处理」，
  // 而这句话会被【原话念给客户】。「后台客服」在客户听来是另一个人 ——
  // 他会以为要换人接手，实际从头到尾就是同一个客服。
  //
  // 起因是 prompt 第一行就告诉它「你是客服的后台 Agent」，同时又要它写
  // 「适合直接念给客户听」的话 —— 两句放在一起，它自然会向客户解释内部流程。
  for (const domain of ['retail', 'airline']) {
    const prompt = basePrompt(domain)
    assert.match(prompt, /客户只知道一个客服/, `${domain} 少了这条约束`)
    assert.match(prompt, /不要说"后台"/, `${domain} 没有列出禁用的内部词`)
    // 只有真转人类坐席时才允许提人工 —— 这个例外必须写清，
    // 否则模型会连 transfer_to_human 那句也不敢说。
    assert.match(prompt, /transfer_to_human/)
    assert.match(prompt, /人工客服/)
  }
})
