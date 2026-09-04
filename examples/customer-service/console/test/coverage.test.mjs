import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { checkCoverage } from '../coverage.mjs'
import { validateDatabase } from '../db-validate.mjs'

const load = (domain, file) => JSON.parse(
  readFileSync(new URL(`../../domains/${domain}/${file}`, import.meta.url), 'utf8'),
)
const guardsOf = domain => load(domain, 'guards.json')
const dbOf = domain => load(domain, 'db.json')

// ── 覆盖度 ──

test('两个域的初始数据都能覆盖全部规则', () => {
  for (const domain of ['retail', 'airline']) {
    const result = checkCoverage(guardsOf(domain), dbOf(domain))
    assert.equal(result.ok, true,
      `${domain} 有缺口：${result.gaps.map(g => g.detail).join(' / ')}`)
  }
})

test('顶层键是 decisions 不是 tables', () => {
  // 【这条守着一个真实的坑】我第一版凭记忆写成 guards.tables，
  // 于是整个检查一行都没跑到 —— 两个域都返回「全部覆盖」。
  // 那个「全绿」看起来像好消息，实际是检查压根没工作。
  const guards = guardsOf('retail')
  assert.ok(guards.decisions, 'guards.decisions 应该存在')
  assert.equal(guards.tables, undefined, '如果这里有 tables，说明结构变了，coverage.mjs 要跟着改')
})

test('policy 引用了库里没有的商品类别时报缺口', () => {
  const guards = structuredClone(guardsOf('retail'))
  guards.decisions.return_window.rules.unshift({ when: { category: 'fresh_food' }, then: 3 })
  const result = checkCoverage(guards, dbOf('retail'))
  assert.equal(result.ok, false)
  const gap = result.gaps.find(item => item.value === 'fresh_food')
  assert.ok(gap, '没报出 fresh_food 这个缺口')
  assert.equal(gap.kind, 'table_value')
  assert.match(gap.detail, /没有任何 category 是 fresh_food/)
})

test('决策表引用了没出现过的订单状态时报缺口', () => {
  const guards = structuredClone(guardsOf('retail'))
  guards.decisions.cancellable.rules.unshift({ when: { status: 'refunding' }, then: 'allow' })
  const result = checkCoverage(guards, dbOf('retail'))
  assert.equal(result.ok, false)
  const gap = result.gaps.find(item => item.value === 'refunding')
  assert.ok(gap)
  // 缺口要说清是哪几行引用的 —— 管理员得知道去改哪
  assert.ok(gap.sources.some(text => text.includes('cancellable')))
})

test('枚举里有库里用不到的取值时报缺口', () => {
  const guards = structuredClone(guardsOf('airline'))
  guards.enums.cabin = [...guards.enums.cabin, 'first']
  const result = checkCoverage(guards, dbOf('airline'))
  assert.equal(result.ok, false)
  const gap = result.gaps.find(item => item.value === 'first')
  assert.ok(gap)
  assert.equal(gap.kind, 'enum_value')
})

test('时限改大到样本全落在期限内时报「只能演示一半」', () => {
  // 【这一类缺口最难自己发现】规则本身没错、数据也没错，
  // 但两者搭不上：改成 90 天之后库里所有家电订单都在期限内，
  // 于是「超期拒退」这条永远演示不出来。
  const guards = structuredClone(guardsOf('retail'))
  for (const rule of guards.decisions.return_window.rules) {
    if (rule.when?.category === 'appliance') rule.then = 90
  }
  const result = checkCoverage(guards, dbOf('retail'))
  assert.equal(result.ok, false)
  const gap = result.gaps.find(item => item.kind === 'boundary')
  assert.ok(gap)
  assert.match(gap.detail, /全部在期限内/)
  assert.match(gap.fix, /签收超过 90 天/)
})

test('缺口带修复建议，不只报问题', () => {
  const guards = structuredClone(guardsOf('retail'))
  guards.decisions.return_window.rules.unshift({ when: { category: 'fresh_food' }, then: 3 })
  const result = checkCoverage(guards, dbOf('retail'))
  for (const gap of result.gaps) {
    assert.ok(gap.fix, `${gap.detail} 没给修复建议`)
  }
})

test('布尔类输入不查库', () => {
  // hasFlownSegment: 'true' 是算出来的，不是库里的字段 ——
  // 拿它去库里找会报一堆假缺口。
  const result = checkCoverage(guardsOf('airline'), dbOf('airline'))
  assert.ok(!result.gaps.some(gap => gap.value === 'true' || gap.value === 'false'))
})

// ── 数据库校验 ──

test('两个域的初始数据引用自洽', () => {
  for (const domain of ['retail', 'airline']) {
    const result = validateDatabase(domain, dbOf(domain))
    assert.equal(result.ok, true,
      `${domain} 有问题：${result.errors.map(e => `${e.path} ${e.message}`).join(' / ')}`)
  }
})

test('订单指向不存在的商品会被拦', () => {
  const db = dbOf('retail')
  db.orders[0].items[0].productId = 'P_GONE'
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].path, /orders\[0\]\.items\[0\]\.productId/)
  // 【每条错误都要说后果】只说「引用错误」的话，
  // 管理员不知道这会让演示怎么坏掉，也就不会当真。
  assert.match(result.errors[0].hint, /商品名/)
})

test('订单指向不存在的用户会被拦', () => {
  const db = dbOf('retail')
  db.orders[0].userId = 'U_GONE'
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].hint, /list_orders 会漏掉这笔/)
})

test('主键重复会被拦 —— 它比缺失更隐蔽', () => {
  const db = dbOf('retail')
  db.products[1].productId = db.products[0].productId
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /主键重复/)
  assert.match(result.errors[0].hint, /find\(\) 只会命中第一条/)
})

test('已签收但没有签收时间会被拦', () => {
  // 退货时限全靠它算 —— 缺了那条规则会走兜底行。
  const db = dbOf('retail')
  const order = db.orders.find(item => item.status === 'delivered')
  delete order.deliveredAt
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /没有签收时间/)
})

test('支付方式不在本人名下会被拦', () => {
  const db = dbOf('retail')
  db.orders[0].payment.methodId = 'pm_someone_else'
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /不在用户/)
})

test('航段指向不存在的航班会被拦', () => {
  const db = dbOf('airline')
  db.reservations[0].segments[0].flightNo = 'CY9999'
  const result = validateDatabase('airline', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /指向不存在的航班/)
  assert.match(result.errors[0].hint, /退票与改签的资格判定全部失灵/)
})

test('航班主键是航班号加日期，不是航班号', () => {
  // 同一航班号可以有多天 —— get_flight_status 里也这么处理的。
  const db = dbOf('airline')
  const first = db.flights[0]
  db.flights[1].flightNo = first.flightNo
  db.flights[1].date = first.date
  const result = validateDatabase('airline', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /航班号加日期重复/)
})

test('同航班号不同日期是合法的', () => {
  const db = dbOf('airline')
  db.flights.push({ ...db.flights[0], date: '2026-12-25' })
  const result = validateDatabase('airline', db)
  assert.equal(result.ok, true, '同号不同天被误判成重复了')
})

test('航班缺票价或余量会被拦', () => {
  for (const [field, pattern] of [['prices', /缺少票价/], ['seats', /缺少余量/]]) {
    const db = dbOf('airline')
    delete db.flights[0][field].business
    const result = validateDatabase('airline', db)
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, pattern)
  }
})

test('预订没有航段会被拦', () => {
  const db = dbOf('airline')
  db.reservations[0].segments = []
  const result = validateDatabase('airline', db)
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /一个航段都没有/)
})

test('缺集合时不往下查 —— 否则噪声压过真问题', () => {
  const db = dbOf('retail')
  delete db.products
  const result = validateDatabase('retail', db)
  assert.equal(result.ok, false)
  // 只报「缺 products」这一条，不报几十条「商品不存在」
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].message, /缺少集合 products/)
})

test('不是对象或未知域时给明确错误', () => {
  assert.equal(validateDatabase('retail', null).ok, false)
  assert.equal(validateDatabase('retail', []).ok, false)
  assert.match(validateDatabase('nope', {}).errors[0].message, /未知的域/)
})
