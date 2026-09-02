import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DecisionTableError,
  HIT_POLICY,
  evaluate,
  validateTable,
} from '../decision-table.mjs'
import {
  checkPreconditions,
  decide,
  enumValues,
  loadGuards,
  sessionFacts,
} from '../guards.mjs'

const WINDOW_TABLE = {
  hitPolicy: HIT_POLICY.FIRST,
  rules: [
    { when: { category: 'digital', daysSinceDelivery: '<= 7' }, then: 'allow' },
    { when: { category: 'appliance', daysSinceDelivery: '<= 15' }, then: 'allow' },
    { when: { category: 'digital' }, then: 'expired', reason: '数码电子类 7 天' },
    { when: { category: 'appliance' }, then: 'expired', reason: '家用电器类 15 天' },
    { when: {}, then: 'policy_gap', reason: '细则未覆盖' },
  ],
}

test('命中具体规则，返回行号', () => {
  const out = evaluate(WINDOW_TABLE, { category: 'digital', daysSinceDelivery: 3 })
  assert.equal(out.outcome, 'allow')
  assert.equal(out.rule, 1)
  assert.equal(out.viaCatchAll, false)
})

test('超出窗口落到 expired 行，带出理由', () => {
  const out = evaluate(WINDOW_TABLE, { category: 'digital', daysSinceDelivery: 22 })
  assert.equal(out.outcome, 'expired')
  assert.match(out.reason, /7 天/)
})

test('未覆盖的类别落到兜底行，而不是返回空', () => {
  // 【这条是「不许编造」的机制形态】家具类在 policy 里没写时限，
  // 表里也就没有它 —— 兜底行把它导向 policy_gap，而不是猜一个天数。
  const out = evaluate(WINDOW_TABLE, { category: 'furniture', daysSinceDelivery: 3 })
  assert.equal(out.outcome, 'policy_gap')
  assert.equal(out.viaCatchAll, true)
})

test('缺兜底行的表在校验时就被拒绝', () => {
  // 装载时报错而不是运行时返回 undefined：调用方多半会把 undefined
  // 当成「没限制」放行，那正好是最危险的默认。
  assert.throws(() => validateTable({
    hitPolicy: HIT_POLICY.FIRST,
    rules: [{ when: { category: 'digital' }, then: 'allow' }],
  }, 'no_catch_all'), DecisionTableError)
})

test('没有 then 的规则被拒绝', () => {
  assert.throws(() => validateTable({
    rules: [{ when: {} }],
  }, 'no_outcome'), /has no outcome/)
})

test('未知 hit policy 被拒绝', () => {
  assert.throws(() => validateTable({
    hitPolicy: 'whatever',
    rules: [{ when: {}, then: 'allow' }],
  }, 'bad_policy'), /unknown hit policy/)
})

test('unique 策略下规则重叠会报错，而不是随便挑一条', () => {
  const table = {
    hitPolicy: HIT_POLICY.UNIQUE,
    rules: [
      { when: { category: 'digital' }, then: 'allow' },
      { when: { daysSinceDelivery: '<= 7' }, then: 'expired' },
      { when: {}, then: 'policy_gap' },
    ],
  }
  // 「退货窗口既是 allow 又是 expired」这种冲突必须暴露出来
  assert.throws(
    () => evaluate(table, { category: 'digital', daysSinceDelivery: 3 }, 'overlap'),
    /declared unique but rules 1, 2 all match/,
  )
})

test('unique 策略下兜底行与具体行重叠不算冲突', () => {
  const table = {
    hitPolicy: HIT_POLICY.UNIQUE,
    rules: [
      { when: { category: 'digital' }, then: 'allow' },
      { when: {}, then: 'policy_gap' },
    ],
  }
  const out = evaluate(table, { category: 'digital' }, 'ok')
  assert.equal(out.outcome, 'allow')
})

test('collect 策略收集所有命中行', () => {
  const table = {
    hitPolicy: HIT_POLICY.COLLECT,
    rules: [
      { when: { amount: '> 2000' }, then: 'over_ceiling', reason: '超上限' },
      { when: { status: 'complaint' }, then: 'complaint', reason: '投诉升级' },
    ],
  }
  const out = evaluate(table, { amount: 3000, status: 'complaint' }, 'triggers')
  assert.deepEqual(out.outcomes, ['over_ceiling', 'complaint'])
  assert.equal(out.reasons.length, 2)
})

test('collect 策略不要求兜底行', () => {
  assert.equal(validateTable({
    hitPolicy: HIT_POLICY.COLLECT,
    rules: [{ when: { amount: '> 2000' }, then: 'escalate' }],
  }, 'collect_ok'), true)
})

// —— 条件表达式 ——

test('六种比较运算符都能用', () => {
  const cases = [
    ['<= 10', 10, true], ['<= 10', 11, false],
    ['>= 10', 10, true], ['>= 10', 9, false],
    ['< 10', 9, true], ['< 10', 10, false],
    ['> 10', 11, true], ['> 10', 10, false],
    ['== 10', 10, true], ['== 10', 11, false],
    ['!= 10', 11, true], ['!= 10', 10, false],
  ]
  for (const [condition, value, expected] of cases) {
    const out = evaluate({
      rules: [{ when: { n: condition }, then: 'hit' }, { when: {}, then: 'miss' }],
    }, { n: value })
    assert.equal(out.outcome, expected ? 'hit' : 'miss', `${condition} vs ${value}`)
  }
})

test('DMN 区间记法的开闭边界要精确', () => {
  // 「7 天内」和「超过 7 天」差一天就是两种业务结果，
  // 所以开闭不能一律当闭区间处理。
  const table = {
    rules: [{ when: { n: '[1..7]' }, then: 'closed' }, { when: {}, then: 'out' }],
  }
  assert.equal(evaluate(table, { n: 1 }).outcome, 'closed')
  assert.equal(evaluate(table, { n: 7 }).outcome, 'closed')
  assert.equal(evaluate(table, { n: 8 }).outcome, 'out')

  const open = {
    rules: [{ when: { n: ']1..7[' }, then: 'open' }, { when: {}, then: 'out' }],
  }
  assert.equal(evaluate(open, { n: 1 }).outcome, 'out', '开区间下界不含')
  assert.equal(evaluate(open, { n: 2 }).outcome, 'open')
  assert.equal(evaluate(open, { n: 7 }).outcome, 'out', '开区间上界不含')
})

test('通配的三种写法都认', () => {
  for (const wildcard of ['-', '*', '']) {
    const out = evaluate({
      rules: [{ when: { category: wildcard }, then: 'any' }],
    }, { category: 'whatever' })
    assert.equal(out.outcome, 'any', `通配 ${JSON.stringify(wildcard)}`)
  }
})

test('数字与数字串视为相等', () => {
  // 管理员在 JSON 里可能写 30 也可能写 "30"
  const table = { rules: [{ when: { n: '30' }, then: 'hit' }, { when: {}, then: 'miss' }] }
  assert.equal(evaluate(table, { n: 30 }).outcome, 'hit')
  assert.equal(evaluate(table, { n: '30' }).outcome, 'hit')
})

test('输入字段缺失时具体条件不命中，落到兜底', () => {
  const out = evaluate(WINDOW_TABLE, {})
  assert.equal(out.outcome, 'policy_gap')
})

// —— guards.json 装载与求值 ——

test('零售 guards.json 能装载，每张表都通过校验', () => {
  const guards = loadGuards('retail')
  assert.equal(guards.domain, 'retail')
  assert.ok(Object.keys(guards.decisions).length >= 5)
  assert.ok(Object.keys(guards.preconditions).length >= 5)
})

test('未知 domain 返回空 guards 而不是抛错', () => {
  const guards = loadGuards('nonexistent-domain')
  assert.deepEqual(guards.preconditions, {})
  assert.deepEqual(guards.decisions, {})
})

test('preconditions 命中时给出缺什么与原文行号', () => {
  const guards = loadGuards('retail')
  const check = checkPreconditions(guards, 'list_orders', { identity: { verified: false } })
  assert.equal(check.ok, false)
  assert.deepEqual(check.missing, ['identity_verified'])
  assert.equal(check.action, 'refuse')
  assert.match(check.message, /核验/)
  assert.equal(typeof check.policyLine, 'number')
})

test('preconditions 满足时放行', () => {
  const guards = loadGuards('retail')
  const check = checkPreconditions(guards, 'list_orders', { identity: { verified: true } })
  assert.equal(check.ok, true)
})

test('没在 preconditions 里声明的工具缺省放行', () => {
  // 【这条是配置化能成立的关键】漏声明退化成「少一道保护」，
  // 而不是「这个工具不能用」。当初反对硬编码状态机的理由就是后者。
  const guards = loadGuards('retail')
  const check = checkPreconditions(guards, 'check_variant', { identity: { verified: false } })
  assert.equal(check.ok, true)
})

test('sessionFacts 的名字进了配置文件，不能随意改', () => {
  const facts = sessionFacts({ identity: { verified: true }, transferred: null })
  assert.deepEqual(Object.keys(facts).sort(), ['identity_verified', 'transferred'])
  assert.equal(facts.identity_verified, true)
  assert.equal(facts.transferred, false)
})

test('decide 走真实的零售决策表', () => {
  const guards = loadGuards('retail')
  const inWindow = decide(guards, 'return_window', { category: 'apparel', daysSinceDelivery: 4 })
  assert.equal(inWindow.outcome, 'allow')

  const expired = decide(guards, 'return_window', { category: 'appliance', daysSinceDelivery: 22 })
  assert.equal(expired.outcome, 'expired')
  assert.match(expired.reason, /15 天/)

  const gap = decide(guards, 'return_window', { category: 'furniture', daysSinceDelivery: 3 })
  assert.equal(gap.outcome, 'policy_gap')
  assert.equal(gap.viaCatchAll, true)
})

test('决策表缺失时返回 unavailable，不默默放行', () => {
  const guards = loadGuards('retail')
  const out = decide(guards, 'no_such_table', {})
  assert.equal(out.available, false)
  assert.equal(out.outcome, null)
})

test('退款权限表按金额分流', () => {
  const guards = loadGuards('retail')
  assert.equal(decide(guards, 'refund_authority', { amount: 899 }).outcome, 'allow')
  assert.equal(decide(guards, 'refund_authority', { amount: 2899 }).outcome, 'escalate')
  // 边界：正好 2000 不该超限
  assert.equal(decide(guards, 'refund_authority', { amount: 2000 }).outcome, 'allow')
})

test('枚举从配置读', () => {
  const guards = loadGuards('retail')
  assert.deepEqual(enumValues(guards, 'cancel_reason'), ['不需要了', '买错了'])
  assert.equal(enumValues(guards, 'nope'), null)
})
