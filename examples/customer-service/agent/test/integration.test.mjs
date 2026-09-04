import assert from 'node:assert/strict'
import test from 'node:test'
import { serviceAgentPrompt } from '../executor.mjs'
import {
  A2ABackendAdapter,
} from '../../../../server/src/backend/a2a-backend-adapter.mjs'
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

// 桩模型：从【任何】消息里找 approval_token。第一次取预览时它在 tool 返回里，
// 恢复执行时 executor 把预览拼进了 user 消息 —— 两处都要认。
// 真实模型看到的是同一段文本，所以这个读法和真实行为一致。
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

async function harness(t, model) {
  const service = new CustomerService()
  // 先核验身份：写库工具在未核验时会拒绝，那条已有单测覆盖，
  // 这里要测的是批准链路，所以把前置条件摆好。
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 'default', surface: 'frontend' })

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
  const { service, backend } = await harness(t, {
    async complete({ messages }) {
      const last = messages.at(-1)
      if (last.role === 'tool') return { content: last.content }
      // 客户拒绝后，objective 里会带上「客户对上述确认的答复」。
      // 桩模型这时不再调工具，直接回话 —— 真实模型也该这样。
      if (/答复/u.test(last.content)) return { content: '好的，那这笔订单我先不动。' }
      return toolCall('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
    },
  })
  const seen = []
  const waitingForInput = pendingInput(backend, seen, t)

  const running = backend.submit({
    id: 'gateway-task-decline', ownerId: 'owner',
    objective: '帮客户取消订单 #W1082334，原因是不需要了',
  })
  const input = await waitingForInput
  await backend.respondInput('gateway-task-decline', input.id, { action: 'decline', text: '客户说不用了' })

  const output = await running
  assert.ok(output.content)
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

test('prompt 不列举任何域特定的工具名', () => {
  // 写「取消订单、退货、改地址是两段式」会漏掉航空那五个，
  // 而漏掉的那些模型可能就不走批准链了。
  for (const domain of ['retail', 'airline']) {
    const prompt = serviceAgentPrompt(domain)
    for (const name of [
      'cancel_order', '取消订单', '退货', '改地址', '款式库存',
      'cancel_reservation', '退票', '改签', '加行李',
    ]) {
      assert.ok(!prompt.includes(name),
        `${domain} 的 prompt 里出现了域特定的工具名「${name}」`)
    }
  }
})

test('prompt 不抄工具的判定话术', () => {
  // 判定话术是工具自己写的，prompt 里再抄一遍只会不一致，而且列不全：
  // 航空有「已有航段执飞」「特价经济舱不可改签」「保险原因只认健康或天气」……
  for (const domain of ['retail', 'airline']) {
    const prompt = serviceAgentPrompt(domain)
    for (const phrase of [
      '超出退货时限', '未发货状态', '已有航段执飞', '特价经济舱不可改签',
    ]) {
      assert.ok(!prompt.includes(phrase),
        `prompt 抄了工具的判定话术「${phrase}」—— 工具改了它就不一致`)
    }
  }
})

test('prompt 靠 approval_token 判断两段式，而不是靠工具名', () => {
  const prompt = serviceAgentPrompt('airline')
  assert.match(prompt, /approval_token/)
  // 这是所有两段式工具的共同特征，加新工具不用改 prompt
  assert.match(prompt, /有没有 approval_token/)
})

test('两个域的 prompt 只差业务名字', () => {
  // 差异越小越好 —— 差异大就意味着有域特定的规则藏在里面，
  // 而那些规则本该在工具或 guards 里。
  const normalize = text => text.replace(/零售客服|航空客服/g, '「域」')
  assert.equal(normalize(serviceAgentPrompt('retail')), normalize(serviceAgentPrompt('airline')))
})
