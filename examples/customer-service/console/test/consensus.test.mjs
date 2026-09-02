import assert from 'node:assert/strict'
import test from 'node:test'
import { consense, fingerprint, topic } from '../consensus.mjs'

function threshold(name, value, { certain = true } = {}) {
  return { kind: 'threshold', name, value, quoteVerified: true, confidence: certain ? 'certain' : 'ambiguous' }
}
function order(before, after) {
  return { kind: 'order', before, after, quoteVerified: true }
}
function run(determined = [], undecided = []) {
  return { determined, undecided }
}

test('指纹包含结论，不只是主题', () => {
  // 「退货窗口 = 30 天」和「= 7 天」是同一主题的两个结论，
  // 必须算分歧 —— 否则两次给出矛盾数字会被当成一致。
  assert.notEqual(
    fingerprint(threshold('refund_ceiling', 2000)),
    fingerprint(threshold('refund_ceiling', 500)),
  )
  // 主题指纹反过来要相同，这样界面上能把它们并排显示
  assert.equal(
    topic(threshold('refund_ceiling', 2000)),
    topic(threshold('refund_ceiling', 500)),
  )
})

test('顺序规则的主题不分方向，指纹分方向', () => {
  // 实测过：同一句原文两次抽出相反的顺序。
  // 指纹必须区分它们（那是分歧），主题必须归到一起（那是同一件事）。
  const forward = order('复述新地址', '修改地址')
  const backward = order('修改地址', '复述新地址')
  assert.notEqual(fingerprint(forward), fingerprint(backward))
  assert.equal(topic(forward), topic(backward))
})

test('交叉表比对整张表，改一格就算分歧', () => {
  const table = rows => ({ kind: 'lookup', name: 'baggage', rows })
  const base = table([{ when: { tier: 'gold' }, then: 4 }])
  const same = table([{ when: { tier: 'gold' }, then: 4 }])
  const changed = table([{ when: { tier: 'gold' }, then: 3 }])
  assert.equal(fingerprint(base), fingerprint(same))
  assert.notEqual(fingerprint(base), fingerprint(changed))
})

test('交叉表的行顺序不影响指纹', () => {
  const table = rows => ({ kind: 'lookup', name: 'baggage', rows })
  const a = table([{ when: { t: 'a' }, then: 1 }, { when: { t: 'b' }, then: 2 }])
  const b = table([{ when: { t: 'b' }, then: 2 }, { when: { t: 'a' }, then: 1 }])
  // 模型输出的行顺序可能变，但那不是业务上的分歧
  assert.equal(fingerprint(a), fingerprint(b))
})

test('三次都一致且都是确定项 → agreed', () => {
  const item = threshold('refund_ceiling', 2000)
  const { agreed, disputed } = consense([run([item]), run([item]), run([item])])
  assert.equal(agreed.length, 1)
  assert.equal(disputed.length, 0)
  assert.equal(agreed[0].agreement, '3/3')
})

test('三次都一致但每次都是待决定 → 仍进 disputed', () => {
  // 【稳定不等于不需要人看】gaps 每次都被抽出来，但它稳定地需要人判断。
  const gap = { kind: 'gap', topic: '明显穿着痕迹的判定标准' }
  const { agreed, disputed } = consense([run([], [gap]), run([], [gap]), run([], [gap])])
  assert.equal(agreed.length, 0)
  assert.equal(disputed.length, 1)
  assert.equal(disputed[0].disputeKind, 'stable_but_ambiguous')
  assert.equal(disputed[0].agreement, '3/3')
})

test('同一主题给出不同结论 → conflicting_values，并排显示', () => {
  const a = threshold('refund_ceiling', 2000)
  const b = threshold('refund_ceiling', 500)
  const { agreed, disputed } = consense([run([a]), run([a]), run([b])])
  assert.equal(agreed.length, 0)
  assert.equal(disputed.length, 1)
  assert.equal(disputed[0].disputeKind, 'conflicting_values')
  // 出现次数最多的作为默认建议
  assert.equal(disputed[0].value, 2000)
  assert.equal(disputed[0].agreement, '2/3')
  // 另一个版本要能被看到，人才能选
  assert.equal(disputed[0].variants.length, 1)
  assert.equal(disputed[0].variants[0].value, 500)
  assert.equal(disputed[0].variants[0].agreement, '1/3')
})

test('只有部分运行抽出来 → partial_agreement', () => {
  const item = threshold('insurance_fee', 60)
  const { disputed } = consense([run([item]), run([]), run([])])
  assert.equal(disputed.length, 1)
  assert.equal(disputed[0].disputeKind, 'partial_agreement')
  assert.equal(disputed[0].agreement, '1/3')
})

test('分歧最大的排最前面', () => {
  const stable = threshold('a', 1)
  const shaky = threshold('b', 2)
  const { disputed } = consense([
    run([stable, shaky]),
    run([stable]),
    run([stable]),
  ])
  // stable 三次都在且都是确定项 → agreed，不进 disputed
  assert.equal(disputed.length, 1)
  assert.equal(disputed[0].name, 'b')
  assert.equal(disputed[0].agreement, '1/3')
})

test('多条分歧按出现次数升序', () => {
  const once = threshold('once', 1)
  const twice = threshold('twice', 2)
  const { disputed } = consense([
    run([once, twice]),
    run([twice]),
    run([]),
  ])
  assert.equal(disputed.length, 2)
  assert.equal(disputed[0].name, 'once', '只出现 1 次的排前面')
  assert.equal(disputed[1].name, 'twice')
})

test('跑一次时所有项都算一致（退化情形）', () => {
  const item = threshold('a', 1)
  const { agreed, runs } = consense([run([item])])
  assert.equal(runs, 1)
  assert.equal(agreed.length, 1)
  assert.equal(agreed[0].agreement, '1/1')
})

test('空输入不报错', () => {
  const out = consense([])
  assert.equal(out.agreed.length, 0)
  assert.equal(out.disputed.length, 0)
  assert.equal(out.runs, 0)
})

test('跨字段的同一条规则被归并，不算冲突', () => {
  // 模型有时把「apparel 退货 30 天」放进 category_windows，
  // 有时放进 thresholds（名字变成 return_window_apparel）。
  // 那是同一条规则的两种落位，指纹必须相同。
  const win = { kind: 'window', category: 'apparel', days: 30, quoteVerified: true }
  const thr = {
    kind: 'threshold', name: 'return_window_apparel', value: 30, unit: '天', quoteVerified: true,
  }
  assert.equal(fingerprint(win), fingerprint(thr))
})

test('同一次运行里同一指纹出现两次，仍算 agreed', () => {
  // 【回归】fromDetermined 原本是计数器：跨字段归并后同一次运行里
  // 两个对象共享一个指纹，计数器加两次，于是 === total 永不成立 ——
  // 四条本来确定的时限全被判成「稳定但模糊」。改成记运行序号的集合。
  const win = { kind: 'window', category: 'apparel', days: 30, quoteVerified: true }
  const thr = {
    kind: 'threshold', name: 'return_window_apparel', value: 30, unit: '天', quoteVerified: true,
  }
  const runs = [1, 2, 3].map(() => ({ determined: [{ ...win }, { ...thr }], undecided: [] }))
  const { agreed, disputed } = consense(runs)
  assert.equal(agreed.length, 1, '应归并成一条 agreed')
  assert.equal(disputed.length, 0)
  assert.equal(agreed[0].agreement, '3/3')
})

test('剥前缀不能把名字剥空', () => {
  // refund_ceiling 不该被剥成 ceiling，否则会和别的 xxx_ceiling 撞。
  const a = { kind: 'threshold', name: 'refund_ceiling', value: 2000 }
  const b = { kind: 'threshold', name: 'compensation_ceiling', value: 2000 }
  assert.notEqual(topic(a), topic(b))
})

test('gap 的不同措辞被聚成一条', () => {
  // 实测：三次抽取对同一件事写了三种说法 ——
  // 「未签收订单的处理边界」「未签收订单的处理流程细化」「未签收订单的处理流程细节」
  // 指纹不同就变成三条待裁决，分歧定位被措辞噪声淹没。
  const gaps = [
    '未签收订单的处理边界',
    '未签收订单的处理流程细化',
    '未签收订单的处理流程细节',
  ].map(text => ({ kind: 'gap', topic: text }))
  const { disputed } = consense([
    { determined: [], undecided: [gaps[0]] },
    { determined: [], undecided: [gaps[1]] },
    { determined: [], undecided: [gaps[2]] },
  ])
  assert.equal(disputed.length, 1, `三种措辞应聚成一条，实际 ${disputed.length} 条`)
  assert.equal(disputed[0].variants.length, 2, '另两种措辞要能展开看到')
})

test('gap 的前缀噪声也要去掉', () => {
  const pair = [
    { kind: 'gap', topic: '未定义‘明显穿着痕迹’的标准' },
    { kind: 'gap', topic: '‘明显穿着痕迹’的判定标准' },
  ]
  const { disputed } = consense([
    { determined: [], undecided: [pair[0]] },
    { determined: [], undecided: [pair[1]] },
  ])
  assert.equal(disputed.length, 1, '「未定义X」和「X」是同一件事')
})

test('不相关的 gap 不会被误并', () => {
  const pair = [
    { kind: 'gap', topic: '换货差价的计算方式' },
    { kind: 'gap', topic: '混合支付退款到账时间' },
  ]
  const { disputed } = consense([
    { determined: [], undecided: [pair[0]] },
    { determined: [], undecided: [pair[1]] },
  ])
  assert.equal(disputed.length, 2, '两件不同的事不该被聚成一条')
})

test('交叉表的维度命名差异不算冲突', () => {
  // reason 与 reason_for_return 是同一个维度的两种写法
  const a = {
    kind: 'lookup', name: 'shipping', inputs: ['reason', 'type'],
    rows: [{ when: { reason: 'quality', type: 'apparel' }, then: 'seller' }],
  }
  const b = {
    kind: 'lookup', name: 'shipping', inputs: ['reason_for_return', 'type'],
    rows: [{ when: { reason_for_return: 'quality', type: 'apparel' }, then: 'seller' }],
  }
  assert.equal(fingerprint(a), fingerprint(b))
})

test('转人工触发条件按文本归并，忽略空白差异', () => {
  const a = { kind: 'escalation', trigger: '退款金额超过 2000 元', quoteVerified: true }
  const b = { kind: 'escalation', trigger: '退款金额超过2000元', quoteVerified: true }
  // 模型输出的空格可能不同，那不是业务分歧
  assert.equal(fingerprint(a), fingerprint(b))
})

test('escalation 的量词差异被聚成一条', () => {
  // 实测：同一条规则一次写「退款金额超过 2000 元」、
  // 一次写「单笔退款金额超过 2000 元」，加起来正好 3/3 却显示成两条。
  const a = { kind: 'escalation', trigger: '退款金额超过 2000 元', quoteVerified: true }
  const b = { kind: 'escalation', trigger: '单笔退款金额超过 2000 元', quoteVerified: true }
  const { disputed } = consense([
    { determined: [a], undecided: [] },
    { determined: [a], undecided: [] },
    { determined: [b], undecided: [] },
  ])
  assert.equal(disputed.length, 1, '两种措辞应聚成一条')
})

test('不同的 escalation 条件不会被误并', () => {
  const a = { kind: 'escalation', trigger: '退款金额超过 2000 元', quoteVerified: true }
  const b = { kind: 'escalation', trigger: '身份核验两种方式都无法通过', quoteVerified: true }
  const { agreed } = consense([
    { determined: [a, b], undecided: [] },
    { determined: [a, b], undecided: [] },
    { determined: [a, b], undecided: [] },
  ])
  assert.equal(agreed.length, 2, '两条不同的转人工条件要各占一行')
})

test('order 不做模糊聚类', () => {
  // 「核验身份 → 取消订单」和「核验身份 → 修改地址」文本很像，
  // 但它们是两条不同的业务约束，不能并。
  const a = { kind: 'order', before: '核验身份', after: '取消订单', quoteVerified: true }
  const b = { kind: 'order', before: '核验身份', after: '修改地址', quoteVerified: true }
  const { agreed } = consense([
    { determined: [a, b], undecided: [] },
    { determined: [a, b], undecided: [] },
  ])
  assert.equal(agreed.length, 2, '两条顺序约束要各占一行')
})

test('gap 和 escalation 不会跨类别聚在一起', () => {
  const gap = { kind: 'gap', topic: '退款金额超过 2000 元的处理' }
  const esc = { kind: 'escalation', trigger: '退款金额超过 2000 元', quoteVerified: true }
  const { agreed, disputed } = consense([
    { determined: [esc], undecided: [gap] },
    { determined: [esc], undecided: [gap] },
  ])
  // 一个是缺口一个是规则，界面上是两种东西
  assert.equal(agreed.length, 1)
  assert.equal(disputed.length, 1)
})
