import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomerService } from '../service.mjs'
import { toolDefinitions } from '../tools/registry.mjs'

async function verified(sessionId, email = 'liming3021@example.com') {
  const service = new CustomerService()
  await service.execute('verify_identity', { email }, { sessionId, surface: 'frontend' })
  return service
}

function backend(service, sessionId) {
  return (name, args) => service.execute(name, args, { sessionId, surface: 'backend' })
}

// 从工具返回的文本里抠出令牌。模型看到的是同一段文本，
// 所以这里怎么抠得到，模型就能怎么读得到。
function tokenFrom(text) {
  return text.match(/approval_token="([^"]+)"/)?.[1] || null
}

test('写库工具只在后台面，不在前台面', () => {
  const frontend = toolDefinitions('frontend').map(tool => tool.name)
  for (const name of ['cancel_order', 'return_items', 'modify_address', 'transfer_to_human']) {
    assert.ok(!frontend.includes(name), `${name} 不该出现在前台面`)
  }
  const all = toolDefinitions('backend').map(tool => tool.name)
  for (const name of ['cancel_order', 'return_items', 'modify_address', 'transfer_to_human']) {
    assert.ok(all.includes(name), `${name} 应该在后台面`)
  }
})

test('transfer_to_human 标不可逆但不涉款', () => {
  const tool = toolDefinitions('backend').find(entry => entry.name === 'transfer_to_human')
  assert.equal(tool.annotations.destructiveHint, true)
  assert.equal(tool.annotations.monetaryHint, false)
})

test('第一次调用只给预览，不碰数据库', async () => {
  const service = await verified('c1')
  const call = backend(service, 'c1')
  const preview = await call('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
  assert.equal(preview.data.needsApproval, true)
  assert.match(preview.content, /将取消订单 #W1082334/)
  assert.match(preview.content, /￥899\.00/)
  assert.ok(tokenFrom(preview.content), '预览里必须带出令牌')

  const { db } = service.snapshot('c1')
  assert.equal(db.orders.find(o => o.orderId === '#W1082334').status, 'pending')
})

test('带令牌的第二次调用才真正执行', async () => {
  const service = await verified('c2')
  const call = backend(service, 'c2')
  const preview = await call('cancel_order', { orderId: '#W1082334', reason: '买错了' })
  const done = await call('cancel_order', {
    orderId: '#W1082334', reason: '买错了', approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.cancelled, true)
  assert.equal(done.data.refund, 899)

  const order = service.snapshot('c2').db.orders.find(o => o.orderId === '#W1082334')
  assert.equal(order.status, 'cancelled')
  assert.equal(order.cancelReason, '买错了')
  assert.ok(order.payment.transactions.some(t => t.type === 'refund' && t.amount === 899))
})

test('没有令牌就执行不了 —— 这是数据依赖，不是 prompt 请求', async () => {
  const service = await verified('c3')
  const call = backend(service, 'c3')
  // 模型编一个令牌，或者干脆不问就填一个
  const forged = await call('cancel_order', {
    orderId: '#W1082334', reason: '不需要了', approval_token: 'i-am-sure-the-user-agreed',
  })
  assert.equal(forged.data.approvalError, 'unknown_or_expired')
  assert.equal(service.snapshot('c3').db.orders.find(o => o.orderId === '#W1082334').status, 'pending')
})

// 【这条测试要精确定位「令牌一次性」，不能借别的检查过关】
// 最初用 cancel_order 写这条：取消后订单变成 cancelled，重放会被 not_pending 拦住，
// 于是把令牌一次性去掉测试照样绿 —— 反证时才发现它什么都没测。
// 改用 modify_address：它不改变 status，重放唯一能被拦住的理由就是令牌已消耗。
test('令牌一次性 —— 同一枚不能用第二次', async () => {
  const service = await verified('c4', 'wangfang2277@example.com')
  const call = backend(service, 'c4')
  const preview = await call('modify_address', {
    orderId: '#W6613075', address: '成都市高新区天府大道 500 号',
  })
  const token = tokenFrom(preview.content)

  const first = await call('modify_address', {
    orderId: '#W6613075', address: '成都市高新区天府大道 500 号', approval_token: token,
  })
  assert.equal(first.data.updated, true)

  // 同一枚令牌再用一次，换个地址 —— 客户从没同意过这个新地址
  const replay = await call('modify_address', {
    orderId: '#W6613075', address: '客户没同意过的地址 999 号', approval_token: token,
  })
  assert.equal(replay.data.approvalError, 'unknown_or_expired')
  assert.match(
    service.snapshot('c4').db.orders.find(o => o.orderId === '#W6613075').address,
    /天府大道/,
    '重放不该改掉地址',
  )
})

test('取消后订单状态变化本身也能拦住重复退款', async () => {
  const service = await verified('c4b')
  const call = backend(service, 'c4b')
  const preview = await call('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
  const token = tokenFrom(preview.content)
  await call('cancel_order', { orderId: '#W1082334', reason: '不需要了', approval_token: token })
  const replay = await call('cancel_order', {
    orderId: '#W1082334', reason: '不需要了', approval_token: token,
  })
  assert.ok(replay.data.approvalError || replay.data.blocked)
  const refunds = service.snapshot('c4b').db.orders
    .find(o => o.orderId === '#W1082334').payment.transactions
    .filter(t => t.type === 'refund')
  assert.equal(refunds.length, 1, '只应有一笔退款')
})

test('令牌绑定具体订单，不能挪用到另一笔', async () => {
  const service = await verified('c5')
  const call = backend(service, 'c5')
  const preview = await call('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
  const token = tokenFrom(preview.content)
  // 李明还有另一笔 pending 单 #W1155602 属于刘洋，换成他自己的 shipped 单来试
  const misuse = await call('modify_address', {
    orderId: '#W6613075', address: '换个地址试试', approval_token: token,
  })
  assert.ok(misuse.data.approvalError || misuse.data.found === false || misuse.data.blocked)
})

test('超过退款上限的不发令牌，直接要求转人工', async () => {
  const service = await verified('c6', 'zhangwei@example.com')
  const call = backend(service, 'c6')
  // #W3301887 是 2899 元的 pending 单
  const result = await call('cancel_order', { orderId: '#W3301887', reason: '不需要了' })
  assert.equal(result.data.blocked, 'over_ceiling')
  assert.equal(result.data.needsApproval, undefined, '超上限时不该发令牌')
  assert.match(result.content, /transfer_to_human/)
  assert.equal(service.snapshot('c6').db.orders.find(o => o.orderId === '#W3301887').status, 'pending')
})

test('已发货的订单不能取消，提示改走退货或拒收', async () => {
  const service = await verified('c7')
  const call = backend(service, 'c7')
  const result = await call('cancel_order', { orderId: '#W5027341', reason: '不需要了' })
  assert.equal(result.data.blocked, 'not_pending')
  assert.match(result.content, /已发货/)
})

test('取消原因只接受两种', async () => {
  const service = await verified('c8')
  const call = backend(service, 'c8')
  const result = await call('cancel_order', { orderId: '#W1082334', reason: '太贵了' })
  assert.match(result.content, /不需要了/)
  assert.equal(result.data.needsApproval, undefined)
})

// —— 资格判定：这一组是本示例最想验证的东西 ——

test('时限内的退货给出预览', async () => {
  const service = await verified('r1')
  const call = backend(service, 'r1')
  // #W5540912 是服饰（30 天窗口），4 天前签收
  const result = await call('return_items', { orderId: '#W5540912' })
  assert.equal(result.data.needsApproval, true)
  assert.match(result.content, /在时限内/)
})

test('超出时限的退货被拒，并说明天数与类别时限', async () => {
  const service = await verified('r2', 'zhangwei@example.com')
  const call = backend(service, 'r2')
  // #W7719204 是电热水壶（家电 15 天），6 月中签收，早就超了
  const result = await call('return_items', { orderId: '#W7719204' })
  assert.equal(result.data.blocked, 'window_expired')
  assert.match(result.content, /家用电器类 15 天/)
  assert.ok(result.data.elapsed > 15)
})

test('细则没覆盖的类别不编造时限，要求转人工', async () => {
  const service = await verified('r3', 'liuyang@example.com')
  const call = backend(service, 'r3')
  // #W3376900 是人体工学椅，category=furniture —— policy 的时限表里刻意没有它
  const result = await call('return_items', { orderId: '#W3376900' })
  assert.equal(result.data.blocked, 'policy_gap')
  assert.match(result.content, /细则里没有规定/)
  assert.match(result.content, /家具/)
  assert.match(result.content, /transfer_to_human/)
  // 关键：不能出现任何天数，否则就是编造
  assert.ok(!/\d+ 天/.test(result.content), `不该给出天数：${result.content}`)
})

test('部分退货只退指定款式，金额按选中项算', async () => {
  const service = await verified('r4', 'liuyang@example.com')
  const call = backend(service, 'r4')
  // #W2094558 含耳机 1299 + 鼠标 379，digital 类 7 天窗口，3 天前签收
  const preview = await call('return_items', {
    orderId: '#W2094558', itemIds: ['HP_WHITE_ANC'],
  })
  assert.equal(preview.data.amount, 1299)
  assert.match(preview.content, /无线耳机/)
  assert.ok(!preview.content.includes('无线鼠标'), '不该把没选的商品算进来')

  const done = await call('return_items', {
    orderId: '#W2094558', itemIds: ['HP_WHITE_ANC'],
    approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.refund, 1299)
  const order = service.snapshot('r4').db.orders.find(o => o.orderId === '#W2094558')
  assert.deepEqual(order.returnedItemIds, ['HP_WHITE_ANC'])
})

test('同一件商品不能退两次', async () => {
  const service = await verified('r5', 'liuyang@example.com')
  const call = backend(service, 'r5')
  const preview = await call('return_items', { orderId: '#W2094558', itemIds: ['HP_WHITE_ANC'] })
  await call('return_items', {
    orderId: '#W2094558', itemIds: ['HP_WHITE_ANC'],
    approval_token: tokenFrom(preview.content),
  })
  const again = await call('return_items', { orderId: '#W2094558', itemIds: ['HP_WHITE_ANC'] })
  assert.equal(again.data.blocked, 'already_returned')
})

test('未签收的订单不走退货流程', async () => {
  const service = await verified('r6')
  const call = backend(service, 'r6')
  const pending = await call('return_items', { orderId: '#W1082334' })
  assert.equal(pending.data.blocked, 'not_delivered')
  assert.match(pending.content, /取消订单/)
  const shipped = await call('return_items', { orderId: '#W5027341' })
  assert.match(shipped.content, /拒收/)
})

test('礼品卡付款的退款即时退回余额', async () => {
  const service = await verified('r7')
  const call = backend(service, 'r7')
  const before = service.snapshot('r7').db.users
    .find(u => u.userId === 'li_ming_3021').paymentMethods
    .find(m => m.id === 'gift_card_4402').balance
  const preview = await call('return_items', { orderId: '#W5540912' })
  assert.match(preview.content, /即时退回礼品卡/)
  await call('return_items', { orderId: '#W5540912', approval_token: tokenFrom(preview.content) })
  const after = service.snapshot('r7').db.users
    .find(u => u.userId === 'li_ming_3021').paymentMethods
    .find(m => m.id === 'gift_card_4402').balance
  assert.equal(Math.round((after - before) * 100) / 100, 258)
})

// —— 改地址与转人工 ——

test('改地址走两段式，第二次才落库', async () => {
  const service = await verified('a1', 'wangfang2277@example.com')
  const call = backend(service, 'a1')
  const preview = await call('modify_address', {
    orderId: '#W6613075', address: '成都市高新区天府大道 500 号 12 栋',
  })
  assert.equal(preview.data.needsApproval, true)
  assert.match(preview.content, /天府大道/)
  assert.equal(
    service.snapshot('a1').db.orders.find(o => o.orderId === '#W6613075').address,
    '成都市武侯区人民南路四段 12 号',
  )
  const done = await call('modify_address', {
    orderId: '#W6613075', address: '成都市高新区天府大道 500 号 12 栋',
    approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.updated, true)
  assert.match(
    service.snapshot('a1').db.orders.find(o => o.orderId === '#W6613075').address,
    /天府大道/,
  )
})

test('已发货的订单不能改地址', async () => {
  const service = await verified('a2', 'wangfang2277@example.com')
  const call = backend(service, 'a2')
  const result = await call('modify_address', { orderId: '#W8825431', address: '别的地方 100 号' })
  assert.equal(result.data.blocked, 'not_pending')
  assert.match(result.content, /拒收/)
})

test('转人工必须写原因', async () => {
  const service = await verified('t1')
  const call = backend(service, 't1')
  const empty = await call('transfer_to_human', { reason: '' })
  assert.match(empty.content, /原因/)
  const ok = await call('transfer_to_human', { reason: '退款金额超过上限，需要主管审批' })
  assert.equal(ok.data.transferred, true)
})

test('写库工具在未核验时全部拒绝', async () => {
  const service = new CustomerService()
  const call = backend(service, 'n1')
  for (const [name, args] of [
    ['cancel_order', { orderId: '#W1082334', reason: '不需要了' }],
    ['return_items', { orderId: '#W5540912' }],
    ['modify_address', { orderId: '#W6613075', address: '某地 1 号' }],
  ]) {
    const result = await call(name, args)
    assert.equal(result.data.blocked, 'identity_required', `${name} 未核验时应被拒`)
  }
  const { audit } = service.snapshot('n1')
  assert.equal(audit.filter(entry => entry.warning).length, 3)
})

test('批准与执行都进审计流水，并标明来自哪个面', async () => {
  const service = await verified('u1')
  const call = backend(service, 'u1')
  const preview = await call('cancel_order', { orderId: '#W1082334', reason: '不需要了' })
  await call('cancel_order', {
    orderId: '#W1082334', reason: '不需要了', approval_token: tokenFrom(preview.content),
  })
  const { audit } = service.snapshot('u1')
  const cancels = audit.filter(entry => entry.tool === 'cancel_order')
  assert.equal(cancels.length, 2, '预览与执行各记一条')
  assert.match(cancels[0].summary, /待客户批准/)
  assert.match(cancels[1].summary, /退款/)
  assert.ok(cancels.every(entry => entry.surface === 'backend'))
})
