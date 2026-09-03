import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomerService } from '../service.mjs'
import {
  allToolNames,
  frontendToolNames,
  toolDefinitions,
} from '../tools/registry.mjs'

// 航空域工具的测试。它和 airline.test.mjs 分工不同：
// 那份测数据与决策表，这份测工具行为。

const air = () => {
  const service = new CustomerService()
  const session = `air-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  return {
    session,
    service,
    call: (name, args = {}) => service.execute(name, args, {
      sessionId: session,
      surface: 'backend',
      domain: 'airline',
    }),
    snapshot: () => service.snapshot(session),
  }
}

// ── 工具集按域分开 ──

test('两个域的工具面互不重叠（除 identity）', () => {
  const retail = new Set(allToolNames('retail'))
  const airline = new Set(allToolNames('airline'))
  const shared = [...retail].filter(name => airline.has(name))
  // 【只有身份核验共用】其余重叠都是错：航空客服不该有 return_items，
  // 零售客服不该有 update_baggages。模型看到用不上的工具会去试，
  // 试完发现数据对不上，那种失败很难归因。
  assert.deepEqual(shared.sort(), ['identity_status', 'verify_identity'])
})

test('航空域没有零售的写库工具', () => {
  const airline = allToolNames('airline')
  for (const forbidden of ['return_items', 'exchange_items', 'cancel_order', 'check_variant']) {
    assert.ok(!airline.includes(forbidden), `航空域不该有 ${forbidden}`)
  }
})

test('零售域没有航空工具', () => {
  const retail = allToolNames('retail')
  for (const forbidden of ['list_reservations', 'get_reservation', 'get_flight_status']) {
    assert.ok(!retail.includes(forbidden), `零售域不该有 ${forbidden}`)
  }
})

test('航空前台白名单全是只读或核验', () => {
  const whitelist = frontendToolNames('airline')
  const definitions = toolDefinitions('backend', 'airline')
  for (const name of whitelist) {
    const tool = definitions.find(item => item.name === name)
    assert.ok(tool, `${name} 没注册`)
    const { readOnlyHint, destructiveHint, monetaryHint } = tool.annotations
    assert.ok(readOnlyHint || name === 'verify_identity',
      `${name} 在前台但不是只读`)
    assert.equal(destructiveHint, false, `${name} 有不可逆后果，不该在前台`)
    assert.equal(monetaryHint, false, `${name} 涉款，不该在前台`)
  }
})

test('调错域的工具时报错说清是哪个域', async () => {
  const { call } = air()
  await assert.rejects(() => call('return_items', {}), /airline 域没有这个工具：return_items/)
})

// ── 身份核验按域分支 ──

test('航空核验不认邮箱', async () => {
  // 细则第一条：会员号，或者姓名 + 证件号后四位。邮箱不是航空的判据。
  const { call } = air()
  const result = await call('verify_identity', { email: 'liming3021@example.com' })
  assert.equal(result.data.verified, false)
  assert.match(result.content, /会员号/)
})

test('会员号核验通过', async () => {
  const { call } = air()
  const result = await call('verify_identity', { memberId: 'CY10023841' })
  assert.equal(result.data.verified, true)
  assert.equal(result.data.customerName, '赵宇')
  // customerName 给界面用，userId 给后续工具做归属过滤 —— 两个都要有
  assert.equal(result.data.userId, 'CY10023841')
})

test('会员号大小写不敏感', async () => {
  const { call } = air()
  const result = await call('verify_identity', { memberId: 'cy10023841' })
  assert.equal(result.data.verified, true)
})

test('姓名加证件后四位核验通过', async () => {
  const { call } = air()
  const result = await call('verify_identity', { name: '孙丽', idTail: '9036' })
  assert.equal(result.data.verified, true)
  assert.equal(result.data.customerName, '孙丽')
})

test('证件后四位单独不能核验', async () => {
  // 后四位的碰撞概率是万分之一，单独用它等于没核验。
  // 细则要求「两项同时一致」。
  const { call } = air()
  const result = await call('verify_identity', { idTail: '9036' })
  assert.equal(result.data.verified, false)
  assert.match(result.content, /同时提供/)
})

test('姓名对但证件后四位错，核验不通过', async () => {
  const { call } = air()
  const result = await call('verify_identity', { name: '孙丽', idTail: '0000' })
  assert.equal(result.data.verified, false)
})

test('核验失败的话术不确认账户是否存在', async () => {
  // 细则第十条：不得在核验身份前确认或否认某个订单是否存在。
  // 说「这个会员号不存在」等于泄露了账户存在性。
  const { call } = air()
  const result = await call('verify_identity', { memberId: 'CY99999999' })
  assert.equal(result.data.verified, false)
  assert.ok(!/不存在|没注册|无此/.test(result.content),
    `话术泄露了账户存在性：${result.content}`)
})

test('identity_status 的方式名按域显示', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const status = await call('identity_status', {})
  assert.match(status.content, /会员号/)
  assert.ok(!/邮箱/.test(status.content), '航空不该显示「邮箱」这个方式名')
})

// ── 三个只读工具 ──

test('未核验时三个只读工具全被拦', async () => {
  for (const name of ['list_reservations', 'get_reservation', 'get_flight_status']) {
    const { call } = air()
    const result = await call(name, { reservationId: 'CYR8801', flightNo: 'CY1201' })
    assert.equal(result.data.blocked, 'precondition', `${name} 未核验时应被拦`)
  }
})

test('未核验的调用留下红色审计', async () => {
  const { call, snapshot } = air()
  await call('list_reservations', {})
  const last = snapshot().audit.at(-1)
  assert.equal(last.ok, false)
  assert.match(last.warning, /list_reservations 缺前置条件/)
})

test('列预订只列本人名下的', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('list_reservations', {})
  // 赵宇名下两笔：CYR8801、CYR8805
  assert.equal(result.data.count, 2)
  assert.match(result.content, /CYR8801/)
  assert.match(result.content, /CYR8805/)
  // 别人的不该出现
  assert.ok(!/CYR8802/.test(result.content), '列出了别人的预订')
})

test('拿别人的预订号也查不出来', async () => {
  // 细则第十一条：不得透露其他客户的任何信息。这一条在工具里硬拦。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('get_reservation', { reservationId: 'CYR8802' })
  assert.equal(result.data.found, false)
  assert.match(result.content, /在这位客户名下没有找到/)
})

test('预订详情算出免费行李额，走 3×3 交叉表', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('get_reservation', { reservationId: 'CYR8801' })
  // 赵宇是金卡，CYR8801 是公务舱 → 4 件
  assert.match(result.content, /免费额度 4 件/)
  assert.match(result.content, /金卡会员/)
})

test('预订详情显式说出已飞航段', async () => {
  // 已飞决定能不能改签、改舱位、退票三件事，而模型看不到 flight.status。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const flown = await call('get_reservation', { reservationId: 'CYR8805' })
  assert.equal(flown.data.hasFlownSegment, true)
  assert.match(flown.content, /已有航段执飞完毕/)

  const upcoming = await call('get_reservation', { reservationId: 'CYR8801' })
  assert.equal(upcoming.data.hasFlownSegment, false)
})

test('预订编号大小写与空格不敏感', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('get_reservation', { reservationId: '  cyr8801 ' })
  assert.equal(result.data.found, true)
})

test('航班状态带出延误时长，但不算补偿', async () => {
  // 【判定不藏进查询】延误时长交回去，让模型按 delay_compensation 表确认。
  // 在只读工具里顺手算出「该赔 400」等于把 guards 的职责挪进了查询。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const result = await call('get_flight_status', { flightNo: 'CY2310', date: '2026-09-18' })
  assert.equal(result.data.status, 'delayed')
  assert.equal(result.data.delayHours, 5)
  assert.match(result.content, /延误 5 小时/)
  // 不该出现补偿金额
  assert.ok(!/400|旅行券/.test(result.content), `顺手算了补偿：${result.content}`)
})

test('查不到的航班直接说查不到', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('get_flight_status', { flightNo: 'CY9999' })
  assert.equal(result.data.found, false)
  assert.match(result.content, /查不到/)
})

test('同一航班号多天有班时，要求确认而不是猜一天', async () => {
  // 客户问的是具体某天，答错一天等于答错一个航班。
  //
  // 【这条要真造出多天数据才测得到】第一版我写完注释就断言
  // 「现有数据里只有一天，所以应该正常返回」—— 那测的是单天路径，
  // 和标题说的事完全无关，是条假测试。
  const { call, service, session } = air()
  await call('verify_identity', { memberId: 'CY10023841' })

  const store = service.store.mutable(session, 'airline')
  const original = store.db.flights.find(item => item.flightNo === 'CY1201')
  store.db.flights.push({ ...original, date: '2026-09-21' })

  const ambiguous = await call('get_flight_status', { flightNo: 'CY1201' })
  assert.equal(ambiguous.data.ambiguous, true)
  assert.match(ambiguous.content, /2026-09-20、2026-09-21/)
  assert.match(ambiguous.content, /请向客户确认是哪一天/)

  // 给了日期就能定位
  const exact = await call('get_flight_status', { flightNo: 'CY1201', date: '2026-09-21' })
  assert.equal(exact.data.found, true)
})
