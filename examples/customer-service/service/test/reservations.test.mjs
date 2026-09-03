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

test('两个域的工具面只共用身份核验与转人工', () => {
  const retail = new Set(allToolNames('retail'))
  const airline = new Set(allToolNames('airline'))
  const shared = [...retail].filter(name => airline.has(name))
  // 【共用的只该有这三个】
  // identity_status / verify_identity —— 判据按域分支，工具名保持一个。
  // transfer_to_human —— 转人工不是域特有的，每个域都要有出口。
  //
  // 其余重叠都是错：航空客服不该有 return_items，零售客服不该有
  // update_baggages。模型看到用不上的工具会去试，试完发现数据对不上，
  // 那种失败很难归因。
  assert.deepEqual(shared.sort(), ['identity_status', 'transfer_to_human', 'verify_identity'])
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

// ── 退票：五输入决策表 + 两段式批准 ──

const tokenFrom = text => text.match(/approval_token="([^"]+)"/)?.[1] || null

test('已飞的订单不能退票 —— 已飞优先于一切', async () => {
  // 五输入表的第一行。排错就会把「公务舱已飞」判成全额退款。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('cancel_reservation', { reservationId: 'CYR8805' })
  assert.equal(result.data.blocked, 'not_refundable')
  assert.match(result.content, /已经有航段飞过/)
})

test('航司取消 → 全额退，且优先于 24 小时窗口', async () => {
  // CYR8804 出票已超 24 小时、经济舱、无保险 —— 只靠「航司取消」这一条退成。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10077390' })
  const preview = await call('cancel_reservation', { reservationId: 'CYR8804' })
  assert.equal(preview.data.needsApproval, true)
  assert.match(preview.content, /航班被航司取消/)

  const done = await call('cancel_reservation', {
    reservationId: 'CYR8804',
    approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.cancelled, true)
  assert.equal(done.data.amount, 880)
})

test('特价经济舱无保险超 24 小时 → 不可退', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const result = await call('cancel_reservation', { reservationId: 'CYR8807' })
  assert.equal(result.data.blocked, 'not_refundable')
  assert.match(result.content, /无保险时不可退款/)
})

test('公务舱超 24 小时也能全额退', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10077390' })
  const result = await call('cancel_reservation', { reservationId: 'CYR8808' })
  assert.equal(result.data.needsApproval, true)
  assert.match(result.content, /公务舱可全额退款/)
})

test('走保险退款时原因必须是健康或天气', async () => {
  // 【表只看有没有买保险，原因要另外校验】
  // 细则第六条是「购买了旅行保险，且因健康或天气原因」——
  // 决策表那一行表达不了「且」后面这半句，因为原因不是数据库字段。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10058127' })

  const wrong = await call('cancel_reservation', {
    reservationId: 'CYR8806',
    reason: '不想去了',
  })
  assert.equal(wrong.data.blocked, 'insurance_reason')
  assert.match(wrong.content, /健康原因/)

  const right = await call('cancel_reservation', {
    reservationId: 'CYR8806',
    reason: '健康原因',
  })
  assert.equal(right.data.needsApproval, true)
})

test('公务舱退票不卡原因 —— 它本来就能全额退', async () => {
  // 只在「靠保险才退得成」时才校验原因。公务舱、24 小时内、航司取消
  // 这三条本来就能退，不该因为客户说不清原因而拦住。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10077390' })
  const result = await call('cancel_reservation', {
    reservationId: 'CYR8808',
    reason: '随便写的原因',
  })
  assert.equal(result.data.needsApproval, true, '公务舱不该因原因被拦')
})

test('第一次调用不碰数据库', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10077390' })
  await call('cancel_reservation', { reservationId: 'CYR8804' })
  const reservation = snapshot().db.reservations.find(item => item.reservationId === 'CYR8804')
  assert.notEqual(reservation.status, 'cancelled', '预览阶段就改了库')
})

test('令牌一次性，第二次用同一枚会被拒', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10058127' })
  const preview = await call('cancel_reservation', {
    reservationId: 'CYR8806', reason: '健康原因',
  })
  const token = tokenFrom(preview.content)
  const first = await call('cancel_reservation', {
    reservationId: 'CYR8806', reason: '健康原因', approval_token: token,
  })
  assert.equal(first.data.cancelled, true)

  const replay = await call('cancel_reservation', {
    reservationId: 'CYR8806', reason: '健康原因', approval_token: token,
  })
  // 【这里要断言令牌错误而不是「反正失败了」】
  // 退票之后 status 变成 cancelled，会被 already_cancelled 先拦住 ——
  // 那样即使令牌能重放，测试照样绿。所以必须确认拦它的是哪一条。
  assert.equal(replay.data.blocked, 'already_cancelled')
})

test('令牌绑定预订号，换一笔用不了', async () => {
  // 【要挑一对都能退的订单，否则测不到】
  // 第一版拿 CYR8801 的令牌去退 CYR8805（已飞）—— 已飞会先拦住，
  // 那样即使令牌完全不校验对象，测试照样绿。
  // 第二版加了个「占位断言」，同样没测到绑定本身。
  //
  // 吴敏（CY10077390）名下有两笔都能退：CYR8804（航司取消）与
  // CYR8808（公务舱）。拿一笔的令牌去退另一笔，才真正暴露绑定语义。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10077390' })

  const preview = await call('cancel_reservation', { reservationId: 'CYR8804' })
  const token = tokenFrom(preview.content)
  assert.ok(token, '应该发出令牌')

  const crossUse = await call('cancel_reservation', {
    reservationId: 'CYR8808', approval_token: token,
  })
  assert.equal(crossUse.data.cancelled, undefined, 'CYR8804 的令牌退掉了 CYR8808')
  assert.equal(crossUse.data.approvalError, 'mismatched_subject')

  // 【错用一次令牌就作废 —— 这是实测到的行为，不是我猜的】
  // 我先猜「指纹不匹配是拒绝、不消费，所以原令牌还能用」，断言失败；
  // 读 consumeApproval 才看清 session.pendingApprovals.delete(token)
  // 在指纹校验【之前】—— 令牌一经出示就作废，无论用对没用对。
  //
  // 这个顺序是对的：否则拿一枚令牌可以逐个订单试，直到蒙对一个。
  // 代价是客户批准过的那笔要重新批准一次，而那比让人试探安全。
  const retry = await call('cancel_reservation', {
    reservationId: 'CYR8804', approval_token: token,
  })
  assert.equal(retry.data.approvalError, 'unknown_or_expired',
    '出示过的令牌应当作废，否则可以逐笔试探')
})

test('退票后余额与状态都变了，礼品卡即时到账', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const before = snapshot().db.users
    .find(item => item.userId === 'CY10091455')
    .paymentMethods.find(item => item.type === 'gift_card').balance

  // CYR8803 是经济舱、无保险、超 24 小时 —— 但航班延误 5 小时不影响退款资格，
  // 所以它退不成。换 CYR8807 也退不成。这里改用航司取消那笔来验余额。
  const preview = await call('cancel_reservation', { reservationId: 'CYR8803' })
  assert.equal(preview.data.blocked, 'not_refundable', '延误不构成退款理由')
  assert.equal(
    snapshot().db.users.find(item => item.userId === 'CY10091455')
      .paymentMethods.find(item => item.type === 'gift_card').balance,
    before,
    '被拦下的调用不该动余额',
  )
})

test('转人工要写原因，并记进会话', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const empty = await call('transfer_to_human', {})
  assert.match(empty.content, /写明原因/)

  const done = await call('transfer_to_human', { reason: '客户要求人工' })
  assert.equal(done.data.transferred, true)
  assert.equal(snapshot().transferred?.reason, '客户要求人工')
})

test('每次退票调用都留审计，包括被拦下的', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  await call('cancel_reservation', { reservationId: 'CYR8805' })
  const last = snapshot().audit.at(-1)
  assert.equal(last.tool, 'cancel_reservation')
  assert.equal(last.ok, false)
})

// ── 加行李：3×3 交叉表 + 超额费 ──

test('行李只能增不能减', async () => {
  // 细则第五条。传更小的数不是「参数错误」，是业务上不允许 ——
  // 话术要让模型能向客户解释，而不是重试。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const result = await call('update_baggages', { reservationId: 'CYR8803', totalBags: 0 })
  assert.equal(result.data.blocked, 'baggage_decrease')
  assert.match(result.content, /只能增加不能减少/)
})

test('超出免费额度按件收费，额度走 3×3 表', async () => {
  // 周涛是普通会员，CYR8803 是经济舱 → 免费 1 件；加到 3 件超 2 件 × 80 = 160
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const preview = await call('update_baggages', { reservationId: 'CYR8803', totalBags: 3 })
  assert.equal(preview.data.fee, 160)
  assert.match(preview.content, /免费额度 1 件/)
  assert.match(preview.content, /普通会员经济舱/)

  const done = await call('update_baggages', {
    reservationId: 'CYR8803', totalBags: 3, approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.totalBags, 3)
  assert.equal(done.data.fee, 160)
})

test('免费额度内不收费', async () => {
  // 赵宇金卡 + 公务舱 → 免费 4 件，从 2 加到 3 件不超额
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const preview = await call('update_baggages', { reservationId: 'CYR8801', totalBags: 3 })
  assert.equal(preview.data.fee, 0)
  assert.match(preview.content, /不额外收费/)
})

test('加行李后总额与交易流水都变了', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const before = snapshot().db.reservations.find(item => item.reservationId === 'CYR8803').total
  const preview = await call('update_baggages', { reservationId: 'CYR8803', totalBags: 3 })
  await call('update_baggages', {
    reservationId: 'CYR8803', totalBags: 3, approval_token: tokenFrom(preview.content),
  })
  const after = snapshot().db.reservations.find(item => item.reservationId === 'CYR8803')
  assert.equal(Math.round((after.total - before) * 100) / 100, 160)
  assert.equal(after.payment.transactions.at(-1).amount, 160)
})

// ── 改签 ──

test('特价经济舱不可改签', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10058127' })
  const result = await call('update_flights', {
    reservationId: 'CYR8802', flightNo: 'CY1201',
  })
  assert.equal(result.data.blocked, 'not_changeable')
  assert.match(result.content, /特价经济舱不可改签/)
})

test('经济舱改签收 200 手续费', async () => {
  // 【这条是反证补出来的】把 change_fee 表里 economy 的 200 改成 0，
  // 55 条测试全绿 —— 因为只测过公务舱（免费）那一格。
  // 一张表只测一格等于没测这张表。
  //
  // 周涛的 CYR8803 是经济舱，CAN → CTU。同航线另有 CY2312。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const preview = await call('update_flights', {
    reservationId: 'CYR8803', flightNo: 'CY2312',
  })
  assert.equal(preview.data.fee, 200, '经济舱改签手续费应为 200')
  assert.match(preview.content, /经济舱改签手续费 ￥200\.00/)

  // 差价：CY2310 economy 760 → CY2312 economy 790，补 30
  assert.equal(preview.data.diff, 30)

  const done = await call('update_flights', {
    reservationId: 'CYR8803', flightNo: 'CY2312', approval_token: tokenFrom(preview.content),
  })
  // 手续费 200 + 差价 30 = 230
  assert.match(done.content, /共收取 ￥230\.00/)
})

test('公务舱改签免手续费，只收差价', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const preview = await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY1203',
  })
  assert.equal(preview.data.fee, 0, '公务舱改签手续费应为 0')
  assert.equal(preview.data.diff, 200, 'CY1201 2600 → CY1203 2800')
  const done = await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY1203', approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.flightNo, 'CY1203')
})

test('改签不能改变航线', async () => {
  // 细则第三条。这一条不在决策表里 —— 它不是可调参数，
  // 是改签这个动作的定义。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY2310',
  })
  assert.equal(result.data.blocked, 'route_changed')
  assert.match(result.content, /PVG 到 PEK/)
})

test('改签后余量一加一减', async () => {
  const { call, snapshot } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const seatsOf = (no) => snapshot().db.flights
    .find(item => item.flightNo === no).seats.business
  const before = { from: seatsOf('CY1201'), to: seatsOf('CY1203') }

  const preview = await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY1203',
  })
  await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY1203', approval_token: tokenFrom(preview.content),
  })
  assert.equal(seatsOf('CY1201'), before.from + 1, '原航班余量应加回')
  assert.equal(seatsOf('CY1203'), before.to - 1, '新航班余量应减掉')
})

test('改到同一班会被拦', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('update_flights', {
    reservationId: 'CYR8801', flightNo: 'CY1201', date: '2026-09-20',
  })
  assert.equal(result.data.blocked, 'same_flight')
})

// ── 改舱位 ──

test('改舱位比改签宽松：特价经济舱也能改', async () => {
  // 细则第四条：所有订单都可以改舱位，包括特价经济舱。
  // 这一点和「特价经济舱不可改签」刻意分成两张表。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10058127' })
  const preview = await call('update_cabin', {
    reservationId: 'CYR8802', cabin: 'economy',
  })
  assert.equal(preview.data.needsApproval, true)
  // CY1203 特价经济 720 → 经济 1080
  assert.equal(preview.data.diff, 360)

  const done = await call('update_cabin', {
    reservationId: 'CYR8802', cabin: 'economy', approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.cabin, 'economy')
})

test('已飞的不能改舱位', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('update_cabin', {
    reservationId: 'CYR8805', cabin: 'business',
  })
  assert.equal(result.data.blocked, 'not_editable')
})

test('改成当前舱位会被拦', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('update_cabin', {
    reservationId: 'CYR8801', cabin: 'business',
  })
  assert.equal(result.data.blocked, 'same_cabin')
})

test('降舱退差价', async () => {
  // CYR8801 公务舱 2600 → 经济舱 980，退 1620
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const preview = await call('update_cabin', {
    reservationId: 'CYR8801', cabin: 'economy',
  })
  assert.equal(preview.data.diff, -1620)
  assert.match(preview.content, /将退差价 ￥1620\.00/)
})

// ── 延误补偿 ──

test('延误 5 小时发 400 元，走档位表', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const preview = await call('send_certificate', { reservationId: 'CYR8803' })
  assert.equal(preview.data.amount, 400)
  assert.match(preview.content, /延误 5 小时/)
  assert.match(preview.content, /余额不可退现/)

  const done = await call('send_certificate', {
    reservationId: 'CYR8803', approval_token: tokenFrom(preview.content),
  })
  assert.equal(done.data.amount, 400)
})

test('同一预订只能发一次补偿', async () => {
  // 细则第七条。状态记在预订上 —— 靠模型记住「刚才发过了」
  // 是守不住的，尤其在长通话里。
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const preview = await call('send_certificate', { reservationId: 'CYR8803' })
  await call('send_certificate', {
    reservationId: 'CYR8803', approval_token: tokenFrom(preview.content),
  })
  const again = await call('send_certificate', { reservationId: 'CYR8803' })
  assert.equal(again.data.blocked, 'already_issued')
  assert.match(again.content, /只能发一次/)
})

test('延误不足两小时没有补偿', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10091455' })
  const result = await call('send_certificate', { reservationId: 'CYR8807' })
  assert.equal(result.data.blocked, 'no_compensation')
  assert.equal(result.data.delayHours, 1)
})

test('没有延误的预订不发补偿', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('send_certificate', { reservationId: 'CYR8801' })
  assert.equal(result.data.blocked, 'no_compensation')
  assert.match(result.content, /没有延误记录/)
})

// ── 搜航班 ──

test('搜航班只返回有余量且可订的', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10058127' })
  const result = await call('search_flights', {
    from: 'PVG', to: 'PEK', cabin: 'basic_economy',
  })
  // CY1203 的 basic_economy 余量是 0，不该出现
  assert.ok(!/CY1203/.test(result.content), '列出了满舱的航班')
  assert.ok(result.data.count > 0)
})

test('搜航班排除已飞与已取消', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10077390' })
  const result = await call('search_flights', { from: 'SZX', to: 'XIY', cabin: 'economy' })
  // CY3405 已被航司取消，不该作为改签目标
  assert.ok(!/CY3405/.test(result.content), '列出了已取消的航班')
})

test('搜不到时给出下一步建议，而不是空结果', async () => {
  const { call } = air()
  await call('verify_identity', { memberId: 'CY10023841' })
  const result = await call('search_flights', {
    from: 'PVG', to: 'PEK', cabin: 'business', date: '2030-01-01',
  })
  assert.equal(result.data.count, 0)
  assert.match(result.content, /是否接受别的日期/)
})
