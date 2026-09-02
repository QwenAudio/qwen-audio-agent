import assert from 'node:assert/strict'
import test from 'node:test'
import { annotate, partition } from '../extract.mjs'

// 这些测试不调模型 —— 喂固定的「模型输出」，锁住 annotate 与 partition 的判据。
// 抽取质量本身靠 runtime 探针观察，那个每次结果不同，不适合当断言。

const LINES = [
  '# 明远优选零售客服细则',                                    // 1
  '',                                                          // 2
  '两种方式都试过仍无法匹配的，不得继续办理任何业务，转人工核实。',  // 3
  '',                                                          // 4
  '| 服饰鞋包 | apparel | 30 天 |',                             // 5
  '',                                                          // 6
  '**单笔退款金额超过 2000 元的，客服不得自行处理，须转人工主管审批。**', // 7
  '',                                                          // 8
  '## 十、禁止事项',                                            // 9
]

test('quote 能落回原文时给出行号', () => {
  const out = annotate({
    escalation_triggers: [{
      trigger: '无法核验身份',
      quote: '两种方式都试过仍无法匹配的，不得继续办理任何业务，转人工核实。',
      confidence: 'certain',
    }],
  }, LINES)
  assert.equal(out.escalationTriggers[0].policyLine, 3)
  assert.equal(out.escalationTriggers[0].quoteVerified, true)
})

test('quote 落不回原文时降级为 ambiguous', () => {
  const out = annotate({
    escalation_triggers: [{
      trigger: '编造的规则',
      quote: '这句话在原文里根本不存在，是模型自己写的。',
      confidence: 'certain',
    }],
  }, LINES)
  assert.equal(out.escalationTriggers[0].policyLine, null)
  assert.equal(out.escalationTriggers[0].quoteVerified, false)
  // 【这条是防幻觉的关键】实测过一次：模型把 prompt 里的示例句当成了原文素材。
  // 若不降级，一条被改写或凭空生成的「规则」会以确定项的身份进配置。
  assert.equal(out.escalationTriggers[0].confidence, 'ambiguous')
})

test('markdown 表格里的 quote 带 ** 与 | 也能落回', () => {
  const out = annotate({
    thresholds: [{
      name: 'refund_ceiling',
      value: 2000,
      unit: '元',
      // 模型常把中文标点换成半角、把 ** 带进来
      quote: '单笔退款金额超过2000元的,客服不得自行处理,须转人工主管审批',
      confidence: 'certain',
    }],
  }, LINES)
  assert.equal(out.thresholds[0].policyLine, 7)
})

test('两端都是章节名的顺序规则被标记出来', () => {
  const out = annotate({
    order_rules: [
      { before: '退款', after: '订单取消', quote: '## 十、禁止事项', confidence: 'certain' },
    ],
  }, LINES)
  assert.equal(out.orderRules[0].rejectedReason, 'looks_like_section_order')
})

test('只有一端是章节名时不误伤', () => {
  const out = annotate({
    order_rules: [{
      before: '身份核验',
      after: '办理任何业务',
      quote: '两种方式都试过仍无法匹配的，不得继续办理任何业务，转人工核实。',
      confidence: 'certain',
    }],
  }, LINES)
  // 「身份核验」既是章节名也是合法动作。第一版按「任一端是章节名」拦，
  // 把这条正确的规则也降级了 —— 判据必须是两端都是。
  assert.equal(out.orderRules[0].rejectedReason, undefined)
})

test('days 缺失时从 quote 里解析出来', () => {
  const out = annotate({
    category_windows: [{ category: 'apparel', quote: '| 服饰鞋包 | apparel | 30 天 |' }],
  }, LINES)
  assert.equal(out.categoryWindows[0].days, 30)
  assert.equal(out.categoryWindows[0].daysFrom, 'quote')
  assert.equal(out.categoryWindows[0].rejectedReason, undefined)
})

test('quote 里也没有天数时才降级', () => {
  const out = annotate({
    category_windows: [{ category: 'furniture', quote: '## 十、禁止事项' }],
  }, LINES)
  assert.equal(out.categoryWindows[0].rejectedReason, 'missing_days')
})

test('有数值且 quote 可核的阈值进确定栏', () => {
  const { determined, undecided } = partition(annotate({
    thresholds: [{
      name: 'refund_ceiling', value: 2000, unit: '元',
      quote: '**单笔退款金额超过 2000 元的，客服不得自行处理，须转人工主管审批。**',
      confidence: 'certain',
    }],
  }, LINES))
  assert.equal(determined.length, 1)
  assert.equal(undecided.length, 0)
  assert.equal(determined[0].kind, 'threshold')
})

test('没有具体数值的阈值进待决定，哪怕原文语气确定', () => {
  const { determined, undecided } = partition(annotate({
    thresholds: [{
      name: 'refund_ceiling', value: null, applies_to: '单笔退款',
      quote: '两种方式都试过仍无法匹配的，不得继续办理任何业务，转人工核实。',
      confidence: 'certain',
    }],
  }, LINES))
  assert.equal(determined.length, 0)
  assert.equal(undecided[0].kind, 'threshold')
})

test('类别时限不看 confidence，只看有没有天数', () => {
  // 【回归】第一版对 window 用 confidence 判断，而 schema 里没要求模型给这个字段，
  // 于是它一律缺省成 ambiguous —— 四条抽对了的时限全被推给人手填。
  const { determined } = partition(annotate({
    category_windows: [{ category: 'apparel', days: 30, quote: '| 服饰鞋包 | apparel | 30 天 |' }],
  }, LINES))
  assert.equal(determined.length, 1)
  assert.equal(determined[0].days, 30)
})

test('顺序规则一律进待决定，不管 confidence 多高', () => {
  // 【实测依据】同一份 policy 连抽三次，order_rules 每次都不同，
  // 其中两次对同一句原文给出相反的顺序。这一项不能自动落地。
  const { determined, undecided } = partition(annotate({
    order_rules: [{
      before: '复述新地址全文确认',
      after: '修改收货地址',
      quote: '两种方式都试过仍无法匹配的，不得继续办理任何业务，转人工核实。',
      confidence: 'certain',
    }],
  }, LINES))
  assert.equal(determined.length, 0, 'order 规则不该进确定栏')
  assert.equal(undecided[0].kind, 'order')
  assert.equal(undecided[0].needsHumanOrder, true)
  // 行号仍要保留：人要能点回原文核对
  assert.equal(undecided[0].policyLine, 3)
})

test('gaps 全部进待决定', () => {
  const { determined, undecided } = partition(annotate({
    gaps: [{ topic: '明显穿着痕迹的判定标准', why: '缺乏客观标准' }],
  }, LINES))
  assert.equal(determined.length, 0)
  assert.equal(undecided[0].kind, 'gap')
})

test('空输入不报错', () => {
  const { determined, undecided } = partition(annotate({}, LINES))
  assert.equal(determined.length, 0)
  assert.equal(undecided.length, 0)
})
