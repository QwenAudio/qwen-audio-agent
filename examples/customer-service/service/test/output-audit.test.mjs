import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomerService } from '../service.mjs'
import { loadGuards } from '../guards.mjs'
import { CHECKED_RULE_IDS, UNCHECKED_RULES, auditUtterance } from '../output-audit.mjs'

// 出口审计的测试。
//
// 【这一层管的是什么】
// guards 管「能不能办」（判定可控），工具返回真实数据（事实可控），
// 但两者都管不了模型【怎么说】—— 工具说「超出时限」，模型可以说成
// 「我帮您申请特批」。判定和事实都对了，出口仍然不可控。
//
// 所以测试要分两组：违规必须报出来，正常话术不能误报。
// 误报比漏报更致命：报告一旦有噪声就没人看，那时漏报也无人察觉。

const guards = loadGuards('retail')
const airlineGuards = loadGuards('airline')

function sessions() {
  const service = new CustomerService()
  const unverified = service.snapshot('audit-unverified', 'retail')
  return { service, unverified }
}

async function verifiedSession(email = 'liming3021@example.com') {
  const service = new CustomerService()
  const id = `audit-${Math.random().toString(36).slice(2, 8)}`
  await service.execute('verify_identity', { email },
    { sessionId: id, surface: 'frontend', domain: 'retail' })
  return service.snapshot(id, 'retail')
}

const TOOL_OUTPUTS = [
  '退货时限 7 天',
  '￥980.00 将退回招商银行信用卡，3 到 7 个工作日到账',
]

const audit = (text, session, extra = {}) => auditUtterance(text, {
  session, guards, toolOutputs: TOOL_OUTPUTS, ...extra,
})

// ── 四条规则各自要报出来 ──

test('说出别人的姓名要报警', async () => {
  const session = await verifiedSession()
  const result = audit('这个邮箱是张伟的，不是您的。', session)
  assert.equal(result.ok, false)
  assert.equal(result.violations[0].rule, 'other_customer_info')
  assert.match(result.violations[0].detail, /张伟/)
})

test('两个字的名字也要抓到', async () => {
  // 【这条守着一个实测发现的漏报】第一版统一用 length < 3 过滤，
  // 于是「张伟」「王芳」这类两字名字全部漏掉 —— 而中文名多数就是两三个字。
  const session = await verifiedSession()
  for (const name of ['张伟', '王芳']) {
    const result = audit(`那是${name}的订单。`, session)
    assert.equal(result.ok, false, `${name} 没被抓到`)
  }
})

test('说本人的名字不算违规', async () => {
  // 核验通过的客户，说他自己的名字是正常的。
  const session = await verifiedSession()
  const me = session.db.users.find(item => item.userId === session.identity.userId)
  const result = audit(`${me.name}您好，您的订单我看到了。`, session)
  assert.equal(result.ok, true, `把本人姓名报成了违规：${JSON.stringify(result.violations)}`)
})

test('未核验就说出真实单号要报警', async () => {
  // 【这一条最容易被违反】客户报一个订单号，模型顺口说「这笔已经发货了」，
  // 那就等于确认了订单存在 —— 而对面还没核验身份。
  const { unverified } = sessions()
  const realId = unverified.db.orders[0].orderId
  const result = audit(`您说的 ${realId} 这笔订单已经发货了。`, unverified)
  assert.equal(result.ok, false)
  assert.equal(result.violations[0].rule, 'order_existence_before_verify')
})

test('核验之后说单号是正常的', async () => {
  const session = await verifiedSession()
  const mine = session.db.orders.find(item => item.userId === session.identity.userId)
  const result = audit(`您的订单 ${mine.orderId} 已经签收了。`, session)
  assert.equal(result.ok, true, `核验后说本人单号被误报：${JSON.stringify(result.violations)}`)
})

test('未核验时的拒绝话术不该被误报', () => {
  const { unverified } = sessions()
  const result = audit('需要先核验您的身份，之后才能查订单。', unverified)
  assert.equal(result.ok, true)
})

test('承诺类措辞要报警', async () => {
  const session = await verifiedSession()
  for (const text of [
    '这笔虽然超期了，我帮您申请一个特批。',
    '我给您破例处理一次。',
    '保证三天内解决。',
  ]) {
    const result = audit(text, session)
    assert.equal(result.ok, false, `没抓到承诺：${text}`)
  }
})

test('没有出处的数字要报警', async () => {
  const session = await verifiedSession()
  const result = audit('退款会在 15 个工作日内到账。', session)
  assert.equal(result.ok, false)
  assert.match(result.violations[0].detail, /15 个工作日/)
})

test('同一个数字配错单位也要报警', async () => {
  // 【这条守着一个实测发现的漏报】第一版把所有配置数字扔进一个 Set，
  // 于是「15 个工作日」查不出来 —— 因为 15 确实在配置里（家电时限 15【天】）。
  // 同一个数字配不同单位是完全不同的承诺。
  const session = await verifiedSession()
  // 15 在配置里是「天」
  assert.equal(audit('家电类 15 天内可以退。', session).ok, true, '15 天该有出处')
  assert.equal(audit('退款 15 个工作日到账。', session).ok, false, '15 个工作日不该有出处')
  assert.equal(audit('赔您 15 元。', session).ok, false, '15 元不该有出处')
})

test('工具返回过的数字不算编的', async () => {
  const session = await verifiedSession()
  for (const text of [
    '退款 3 到 7 个工作日到账。',
    '会退回 980 元到您的招商银行信用卡。',
  ]) {
    assert.equal(audit(text, session).ok, true, `误报了工具说过的数字：${text}`)
  }
})

test('推测语气讲业务事实要报警', async () => {
  const session = await verifiedSession()
  const result = audit('您那笔退款应该是已经到账了。', session)
  assert.equal(result.ok, false)
  assert.equal(result.violations[0].rule, 'speculation')
})

test('推测词不挨着业务事实时不报', async () => {
  // 「可能需要稍等一下」这种不涉及业务事实的，不该报。
  // 【误报比漏报更致命】报告一有噪声就没人看，那时漏报也无人察觉。
  const session = await verifiedSession()
  for (const text of [
    '可能需要稍等一下，我这边查一查。',
    '大概是这样的，您稍等。',
  ]) {
    assert.equal(audit(text, session).ok, true, `误报了无害的推测词：${text}`)
  }
})

// ── 报告本身要说清边界 ──

test('每条违规都带 policy 行号', async () => {
  // 【行号是这一层的价值所在】不带行号的话，报告只是「这句话不对」，
  // 而带了行号就能追到细则原文 —— 出纠纷时那是唯一能拿出来的依据。
  const session = await verifiedSession()
  const result = audit('我帮您申请特批，那是张伟的订单，应该是已经退款了。', session)
  assert.equal(result.ok, false)
  for (const violation of result.violations) {
    assert.ok(Number.isInteger(violation.policyLine),
      `${violation.rule} 没给行号`)
    assert.ok(violation.title, `${violation.rule} 没给标题`)
  }
})

test('行号按域取 —— 两个域的禁止事项在不同行', async () => {
  const session = await verifiedSession()
  const retailResult = audit('我帮您申请特批。', session)

  const airService = new CustomerService()
  await airService.execute('verify_identity', { memberId: 'CY10023841' },
    { sessionId: 'audit-air', surface: 'frontend', domain: 'airline' })
  const airSession = airService.snapshot('audit-air', 'airline')
  const airResult = auditUtterance('我帮您申请特批。', {
    session: airSession, guards: airlineGuards, toolOutputs: [],
  })

  assert.notEqual(retailResult.violations[0].policyLine, airResult.violations[0].policyLine,
    '两个域的行号应该不同')
})

test('没做机检的那条要显式报出来', async () => {
  // 【不报的话会给人错觉】看到「零违规」会以为五条都守着，
  // 而「不得对商品质量给出主观评价」压根没做机检 ——
  // 它要判断一句话是不是「主观评价」，那是语义问题。
  const session = await verifiedSession()
  const result = audit('您好，有什么可以帮您。', session)
  assert.equal(result.ok, true)
  assert.ok(result.unchecked.length > 0, '没有报出未机检的规则')
  const skipped = result.unchecked[0]
  assert.equal(skipped.rule, 'subjective_evaluation')
  assert.ok(Number.isInteger(skipped.policyLine))
  assert.match(skipped.why, /语义/)
})

test('做了机检的是四条，不是五条', () => {
  // 明确记下覆盖范围。加了新规则要同步改这里 ——
  // 那正是要提醒的：新增规则必须同时更新「没做的那些」清单。
  assert.equal(CHECKED_RULE_IDS.length, 4)
  assert.deepEqual(CHECKED_RULE_IDS.slice().sort(), [
    'order_existence_before_verify',
    'other_customer_info',
    'promise_beyond_policy',
    'speculation',
  ])
  assert.equal(UNCHECKED_RULES.length, 1)
})

test('空话不报警，也不报错', () => {
  const { unverified } = sessions()
  for (const text of ['', '   ', null, undefined]) {
    const result = auditUtterance(text, { session: unverified, guards })
    assert.equal(result.ok, true)
  }
})

test('缺 session 或 guards 时不崩', () => {
  // 审计是旁路的，它自己出错不该带崩通话。
  assert.equal(auditUtterance('随便一句话').ok, true)
  assert.equal(auditUtterance('赔您 999 元', { guards: null }).ok, false)
})
