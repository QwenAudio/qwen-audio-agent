import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomerService } from '../service.mjs'
import { FRONTEND_TOOL_NAMES, toolDefinitions } from '../tools/registry.mjs'

function fresh() {
  return new CustomerService()
}

test('前台工具面是后台的子集，不是互斥的两个列表', () => {
  const frontend = toolDefinitions('frontend').map(tool => tool.name)
  const backend = toolDefinitions('backend').map(tool => tool.name)
  assert.ok(frontend.length > 0)
  assert.ok(backend.length >= frontend.length)
  for (const name of frontend) {
    assert.ok(backend.includes(name), `${name} 在前台面但不在后台面 —— 破坏了「全集+子集」`)
  }
})

test('白名单与实际暴露的前台工具一致', () => {
  const exposed = toolDefinitions('frontend').map(tool => tool.name).sort()
  assert.deepEqual(exposed, [...FRONTEND_TOOL_NAMES].sort())
})

test('不可逆动作不出现在前台面', () => {
  for (const tool of toolDefinitions('frontend')) {
    assert.equal(
      tool.annotations.destructiveHint, false,
      `${tool.name} 标了 destructive 却在前台直出 —— 会绕过 auth_required`,
    )
    assert.equal(tool.annotations.monetaryHint, false, `${tool.name} 涉款却在前台直出`)
  }
})

test('surface 只接受 frontend / backend', async () => {
  const service = fresh()
  await assert.rejects(
    () => service.execute('identity_status', {}, { surface: 'sideways' }),
    /Unknown tool surface/,
  )
})

test('未核验时查订单被硬拒，并留下 warning', async () => {
  const service = fresh()
  const result = await service.execute('list_orders', {}, { sessionId: 's1', surface: 'frontend' })
  assert.equal(result.data.blocked, 'precondition')
  assert.deepEqual(result.data.missing, ['identity_verified'])
  assert.match(result.content, /先核验/)
  const { audit } = service.snapshot('s1')
  // warning 文案现在由 guards.mjs 拼，含缺失的事实名
  assert.match(audit.at(-1).warning, /list_orders 缺前置条件：identity_verified/)
  assert.equal(audit.at(-1).ok, false)
})

test('邮箱核验通过后能查到订单', async () => {
  const service = fresh()
  const verified = await service.execute(
    'verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's2', surface: 'frontend' },
  )
  assert.equal(verified.data.verified, true)
  assert.equal(verified.data.customerName, '李明')

  const orders = await service.execute('list_orders', {}, { sessionId: 's2', surface: 'frontend' })
  assert.equal(orders.data.blocked, undefined)
  assert.ok(orders.data.count > 0)
})

test('没有邮箱的客户必须走姓名+邮编（逼出第二条核验分支）', async () => {
  const service = fresh()
  // 陈静在库里 email 为空，用空邮箱不该命中她
  const byEmpty = await service.execute(
    'verify_identity', { email: '' }, { sessionId: 's3', surface: 'frontend' },
  )
  assert.equal(byEmpty.data.verified, false)

  const byNameZip = await service.execute(
    'verify_identity', { name: '陈静', zip: '510620' },
    { sessionId: 's3', surface: 'frontend' },
  )
  assert.equal(byNameZip.data.verified, true)
  assert.equal(byNameZip.data.customerName, '陈静')
})

test('姓名与邮编只给一项时，提示补齐而不是报参数错误', async () => {
  const service = fresh()
  const result = await service.execute(
    'verify_identity', { name: '陈静' }, { sessionId: 's4', surface: 'frontend' },
  )
  assert.equal(result.data.verified, false)
  assert.match(result.content, /同时提供/)
})

test('查不到时不区分「不存在」与「不是本人的」', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's5', surface: 'frontend' })
  // #W3301887 是张伟的订单，李明不该看到任何区别于「查不到」的信息
  const other = await service.execute('get_order', { orderId: '#W3301887' },
    { sessionId: 's5', surface: 'frontend' })
  const ghost = await service.execute('get_order', { orderId: '#W0000000' },
    { sessionId: 's5', surface: 'frontend' })
  assert.equal(other.content, ghost.content)
  assert.equal(other.data.found, false)
})

test('订单号后四位能匹配，撞号时要求念完整号', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's6', surface: 'frontend' })
  const byTail = await service.execute('get_order', { orderId: '8156' },
    { sessionId: 's6', surface: 'frontend' })
  assert.equal(byTail.data.orderId, '#W2378156')
})

test('订单详情带出类别与签收天数（资格判定的两个必要输入）', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's7', surface: 'frontend' })
  const detail = await service.execute('get_order', { orderId: '#W2378156' },
    { sessionId: 's7', surface: 'frontend' })
  assert.match(detail.content, /类别：/)
  assert.match(detail.content, /距今 \d+ 天/)
  assert.equal(typeof detail.data.deliveredDays, 'number')
})

test('列表超过三笔时截断并说明剩余数量', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's8', surface: 'frontend' })
  const list = await service.execute('list_orders', {}, { sessionId: 's8', surface: 'frontend' })
  assert.ok(list.data.count > 3, '李明的订单应超过三笔，否则测不到截断')
  assert.match(list.content, /还有 \d+ 笔/)
  assert.equal(list.content.split('\n').filter(line => line.startsWith('#W')).length, 3)
})

test('前台面写入的核验状态，后台面立刻可见（同一份状态源）', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's9', surface: 'frontend' })
  const fromBackend = await service.execute('identity_status', {},
    { sessionId: 's9', surface: 'backend' })
  assert.equal(fromBackend.data.verified, true)
  assert.match(fromBackend.content, /李明/)
})

test('audit 记录了调用来自哪个面', async () => {
  const service = fresh()
  await service.execute('identity_status', {}, { sessionId: 's10', surface: 'frontend' })
  await service.execute('identity_status', {}, { sessionId: 's10', surface: 'backend' })
  const { audit } = service.snapshot('s10')
  assert.deepEqual(audit.map(entry => entry.surface), ['frontend', 'backend'])
})

test('reset 把库和身份都清回初始状态', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's11', surface: 'frontend' })
  assert.equal(service.snapshot('s11').identity.verified, true)
  service.reset('s11')
  const after = service.snapshot('s11')
  assert.equal(after.identity.verified, false)
  assert.equal(after.audit.length, 0)
  assert.equal(after.version, 0)
})

test('会话之间互不可见', async () => {
  const service = fresh()
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 'a', surface: 'frontend' })
  assert.equal(service.snapshot('a').identity.verified, true)
  assert.equal(service.snapshot('b').identity.verified, false)
})

test('状态变化会推给订阅者', async () => {
  const service = fresh()
  const seen = []
  const stop = service.subscribe('s12', snapshot => seen.push(snapshot.version))
  await service.execute('verify_identity', { email: 'liming3021@example.com' },
    { sessionId: 's12', surface: 'frontend' })
  stop()
  assert.ok(seen.length > 0, '核验成功应触发状态推送')
})

test('未注册的工具名会被拒绝', async () => {
  const service = fresh()
  await assert.rejects(
    () => service.execute('drop_database', {}, { sessionId: 's13', surface: 'backend' }),
    // 报错要说清是哪个域没有 —— 工具集按域组装之后，
    // 「Unknown tool: return_items」会让人以为没实现，
    // 而实际是航空域压根不该有它。
    /retail 域没有这个工具：drop_database/,
  )
})
