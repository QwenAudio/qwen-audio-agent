import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { decide, enumValues, loadGuards, threshold } from '../guards.mjs'

const db = JSON.parse(readFileSync(
  new URL('../../domains/airline/db.json', import.meta.url), 'utf8',
))
const guards = loadGuards('airline')

// ── 数据完整性 ──

test('用户与订单的引用自洽', () => {
  const users = new Set(db.users.map(user => user.userId))
  for (const item of db.reservations) {
    assert.ok(users.has(item.userId), `${item.reservationId} 的 userId 不存在`)
  }
})

test('订单里的航班号都能找到航班', () => {
  const flights = new Set(db.flights.map(flight => flight.flightNo))
  for (const item of db.reservations) {
    for (const segment of item.segments) {
      assert.ok(flights.has(segment.flightNo),
        `${item.reservationId} 引用了不存在的航班 ${segment.flightNo}`)
    }
  }
})

test('订单支付方式属于下单用户', () => {
  const owned = new Map(db.users.map(user => [
    user.userId, new Set(user.paymentMethods.map(method => method.id)),
  ]))
  for (const item of db.reservations) {
    assert.ok(owned.get(item.userId).has(item.payment.methodId),
      `${item.reservationId} 用了不属于 ${item.userId} 的支付方式`)
  }
})

test('订单总额与航班票价对得上', () => {
  const priceOf = new Map(db.flights.map(flight => [flight.flightNo, flight.prices]))
  for (const item of db.reservations) {
    const fare = item.segments.reduce(
      (acc, segment) => acc + priceOf.get(segment.flightNo)[item.cabin], 0,
    )
    const insurance = item.insurance ? 60 * item.passengers.length : 0
    assert.equal(
      Math.round(item.total * 100), Math.round((fare + insurance) * 100),
      `${item.reservationId} 总额 ${item.total} 与票价${insurance ? '+保险' : ''} ${fare + insurance} 不符`,
    )
  }
})

test('舱位与会员等级都在枚举内', () => {
  const cabins = new Set(enumValues(guards, 'cabin'))
  const tiers = new Set(enumValues(guards, 'member_tier'))
  for (const item of db.reservations) {
    assert.ok(cabins.has(item.cabin), `${item.reservationId} 舱位 ${item.cabin} 不在枚举内`)
  }
  for (const user of db.users) {
    assert.ok(tiers.has(user.memberTier), `${user.userId} 会员等级不在枚举内`)
  }
})

// ── 场景覆盖：少一类，对应演示就走不通 ──

test('场景覆盖：三个舱位都有订单', () => {
  const cabins = new Set(db.reservations.map(item => item.cabin))
  for (const wanted of ['basic_economy', 'economy', 'business']) {
    assert.ok(cabins.has(wanted), `缺少 ${wanted} 的订单`)
  }
})

test('场景覆盖：三个会员等级都有用户', () => {
  const tiers = new Set(db.users.map(user => user.memberTier))
  for (const wanted of ['regular', 'silver', 'gold']) {
    assert.ok(tiers.has(wanted), `缺少 ${wanted} 会员`)
  }
})

test('场景覆盖：延误落在补偿的不同档位', () => {
  const delays = db.flights.filter(f => f.status === 'delayed').map(f => f.delayHours)
  assert.ok(delays.some(h => h <= 2), '缺少「不够补偿门槛」的延误')
  assert.ok(delays.some(h => h > 4 && h <= 8), '缺少 400 元档的延误')
})

test('场景覆盖：有被航司取消的航班、有已飞的航班', () => {
  assert.ok(db.flights.some(f => f.status === 'cancelled'), '缺少取消的航班')
  assert.ok(db.flights.some(f => f.status === 'flown'), '缺少已飞的航班')
})

test('场景覆盖：有买了保险的订单，也有没买的', () => {
  assert.ok(db.reservations.some(item => item.insurance), '缺少有保险的订单')
  assert.ok(db.reservations.some(item => !item.insurance), '缺少无保险的订单')
})

test('场景覆盖：有航班某个舱位售罄（用于换班时的余量校验）', () => {
  assert.ok(
    db.flights.some(f => Object.values(f.seats).some(n => n === 0)),
    '所有航班所有舱位都有余量，售罄场景测不到',
  )
})

// ── 决策表 ──

test('免费行李额：3×3 交叉表九格全对', () => {
  // 【这是决策表 schema 相对扁平配置的关键检验】
  // 两个输入列天然支持交叉，不需要嵌套结构。
  const expected = {
    regular: { basic_economy: 0, economy: 1, business: 2 },
    silver: { basic_economy: 1, economy: 2, business: 3 },
    gold: { basic_economy: 2, economy: 3, business: 4 },
  }
  for (const [memberTier, row] of Object.entries(expected)) {
    for (const [cabin, want] of Object.entries(row)) {
      const got = decide(guards, 'free_baggage_allowance', { memberTier, cabin })
      assert.equal(got.outcome, want, `${memberTier} × ${cabin} 应为 ${want}`)
    }
  }
})

test('免费行李额：未覆盖的组合走兜底并标记出来', () => {
  const out = decide(guards, 'free_baggage_allowance', { memberTier: 'platinum', cabin: 'first' })
  assert.equal(out.outcome, 0)
  assert.equal(out.viaCatchAll, true)
  assert.match(out.reason, /没有规定/)
})

test('延误补偿：区间开闭边界精确', () => {
  // 「2 至 4 小时」写成 ]2..4]：2 小时不含（无补偿），4 小时含（200）。
  // 差一天/一小时就是两种业务结果，所以边界必须逐个验。
  const cases = [[1, 0], [2, 0], [2.5, 200], [4, 200], [4.5, 400], [8, 400], [9, 600]]
  for (const [hours, want] of cases) {
    assert.equal(
      decide(guards, 'delay_compensation', { delayHours: hours }).outcome, want,
      `延误 ${hours} 小时应补 ${want} 元`,
    )
  }
})

test('延误 2 小时命中兜底行，不是 200 那一行', () => {
  // 【这条补的是上面那组测试的漏洞】
  // 反证时把 ]2..4] 改成 [2..4]，上面 7 个断言全绿 —— 因为 delayHours=2
  // 在两种写法下最终结果都是 0：闭区间下它命中第 3 行得 200？不，
  // 实测它命中的是【第 4 行兜底】，所以第 3 行的开闭压根不影响它。
  // 只断言「值等于 0」测不出开闭，必须断言「命中的是哪一行」。
  const at2 = decide(guards, 'delay_compensation', { delayHours: 2 })
  assert.equal(at2.viaCatchAll, true, '延误 2 小时应落到兜底行')
  const at2point5 = decide(guards, 'delay_compensation', { delayHours: 2.5 })
  assert.equal(at2point5.viaCatchAll, false, '延误 2.5 小时应命中具体规则')
  assert.equal(at2point5.outcome, 200)
})

test('延误补偿：上界含、下界不含，逐行核对命中位置', () => {
  // ]4..8] 这一行：4 不含（该落到 ]2..4] 那行），8 含。
  const at4 = decide(guards, 'delay_compensation', { delayHours: 4 })
  assert.equal(at4.outcome, 200, '4 小时属于 2-4 档')
  const at8 = decide(guards, 'delay_compensation', { delayHours: 8 })
  assert.equal(at8.outcome, 400, '8 小时属于 4-8 档')
  const at8point1 = decide(guards, 'delay_compensation', { delayHours: 8.1 })
  assert.equal(at8point1.outcome, 600, '超过 8 小时进最高档')
  // 命中行号也要对上，否则「值碰巧相同」会掩盖规则错位
  assert.equal(at4.rule, 3, '4 小时应命中第 3 行')
  assert.equal(at8.rule, 2, '8 小时应命中第 2 行')
  assert.equal(at8point1.rule, 1, '8.1 小时应命中第 1 行')
})

test('退票资格：规则顺序决定结果', () => {
  // 已飞必须优先于一切 —— 否则公务舱已飞也会被判全额退款
  assert.equal(
    decide(guards, 'refundable', { hasFlownSegment: 'true', cabin: 'business' }).outcome,
    'refuse',
  )
  // 航司取消必须优先于「超 24 小时」
  assert.equal(
    decide(guards, 'refundable', {
      flightStatus: 'cancelled', cabin: 'basic_economy', hoursSinceBooking: 100,
    }).outcome,
    'full_refund',
  )
  assert.equal(
    decide(guards, 'refundable', { hoursSinceBooking: 5, cabin: 'basic_economy' }).outcome,
    'full_refund',
  )
  assert.equal(
    decide(guards, 'refundable', { hoursSinceBooking: 100, cabin: 'business' }).outcome,
    'full_refund',
  )
  assert.equal(
    decide(guards, 'refundable', {
      hoursSinceBooking: 100, cabin: 'economy', hasInsurance: 'true',
    }).outcome,
    'full_refund',
  )
  assert.equal(
    decide(guards, 'refundable', { hoursSinceBooking: 100, cabin: 'basic_economy' }).outcome,
    'refuse',
  )
})

test('改签资格：特价经济舱不可改，已飞不可改', () => {
  assert.equal(decide(guards, 'changeable', { cabin: 'basic_economy' }).outcome, 'refuse')
  assert.match(decide(guards, 'changeable', { cabin: 'basic_economy' }).reason, /升舱/)
  assert.equal(decide(guards, 'changeable', { cabin: 'economy' }).outcome, 'allow')
  assert.equal(decide(guards, 'changeable', { cabin: 'business' }).outcome, 'allow')
  assert.equal(
    decide(guards, 'changeable', { cabin: 'business', hasFlownSegment: 'true' }).outcome,
    'refuse',
  )
})

test('改舱位比改签宽松：特价经济舱也能改', () => {
  // 细则第四条：所有订单都可以改舱位，包括特价经济舱。
  // 这条容易和「特价经济舱不可改签」混起来 —— 两张表分开正是为了区分它们。
  assert.equal(decide(guards, 'cabin_changeable', {}).outcome, 'allow')
  assert.equal(decide(guards, 'cabin_changeable', { hasFlownSegment: 'true' }).outcome, 'refuse')
})

test('改签手续费按舱位', () => {
  assert.equal(decide(guards, 'change_fee', { cabin: 'economy' }).outcome, 200)
  assert.equal(decide(guards, 'change_fee', { cabin: 'business' }).outcome, 0)
  // -1 表示「不可改签」，与「免费（0）」区分开
  assert.equal(decide(guards, 'change_fee', { cabin: 'basic_economy' }).outcome, -1)
})

test('航空的退款上限是 3000，比零售高', () => {
  assert.equal(decide(guards, 'refund_authority', { amount: 2600 }).outcome, 'allow')
  assert.equal(decide(guards, 'refund_authority', { amount: 3001 }).outcome, 'escalate')
  const retail = loadGuards('retail')
  assert.equal(decide(retail, 'refund_authority', { amount: 2600 }).outcome, 'escalate')
})

test('下划线开头的键是注释，不进配置', () => {
  // guards.json 里每张表旁边都有 _xxx_note 说明为什么这么排。
  // JSON 不支持注释，而这些文件是给人改的 —— 说明必须能跟表放在一起。
  for (const key of Object.keys(guards.decisions)) {
    assert.ok(!key.startsWith('_'), `${key} 是注释键，不该被当成决策表`)
  }
  assert.ok(Object.keys(guards.decisions).length >= 7)
})

test('单值阈值从 thresholds 读', () => {
  assert.equal(threshold(guards, 'extra_baggage_fee'), 80)
  assert.equal(threshold(guards, 'insurance_per_passenger'), 60)
  assert.equal(threshold(guards, 'free_cancel_hours'), 24)
  // 拉不到时返回 fallback，不抛错 —— 缺一个费率不该让整通电话停掉
  assert.equal(threshold(guards, 'nope', 999), 999)
})

test('每个订单都能算出免费行李额', () => {
  const tierOf = new Map(db.users.map(user => [user.userId, user.memberTier]))
  for (const item of db.reservations) {
    const out = decide(guards, 'free_baggage_allowance', {
      memberTier: tierOf.get(item.userId),
      cabin: item.cabin,
    })
    assert.equal(typeof out.outcome, 'number', `${item.reservationId} 算不出行李额`)
    assert.equal(out.viaCatchAll, false, `${item.reservationId} 走了兜底，说明组合没覆盖`)
  }
})
