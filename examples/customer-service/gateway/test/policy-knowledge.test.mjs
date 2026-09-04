import assert from 'node:assert/strict'
import test from 'node:test'
import { PolicyKnowledgeProvider } from '../policy-knowledge.mjs'

// policy 检索源的测试。它是「客服说的每个数字都能追到细则第几行」这条链的起点，
// 所以断言集中在两件事：原文一字不改、行号对得上。

test('协议要求的方法名是 retrieve，不是 search', () => {
  // 【踩过】第一版写成 search，网关装配直接抛
  // 「KnowledgeRetrievalProvider is missing required methods: retrieve」。
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  assert.equal(typeof provider.describe, 'function')
  assert.equal(typeof provider.retrieve, 'function')
  assert.equal(typeof provider.health, 'function')
})

test('describe 声明协议版本与身份', () => {
  const description = new PolicyKnowledgeProvider({ domain: 'retail' }).describe()
  assert.equal(description.protocolVersion, 1)
  assert.match(description.key, /^[a-z0-9][a-z0-9-]*$/)
  assert.equal(description.label, '明远优选零售客服细则')
})

test('装载后 health 是 ready', () => {
  assert.equal(new PolicyKnowledgeProvider({ domain: 'retail' }).health().status, 'ready')
})

test('未知域直接报错，不静默降级成空', () => {
  // 空的检索源比没有检索源更糟：模型以为查过了，实际什么都没查到。
  assert.throws(() => new PolicyKnowledgeProvider({ domain: 'nope' }), /未知的客服域/)
})

test('按章节切分，行号指向 ## 标题所在行', async () => {
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const sections = provider.sections()
  assert.ok(sections.length >= 10, `只切出 ${sections.length} 节`)
  const window = sections.find(section => section.heading.includes('退货时限'))
  assert.equal(window.startLine, 16, '退货时限应在 policy.md 第 16 行')
  assert.equal(window.domain, 'retail')
})

test('检索结果的原文一字不改', async () => {
  // 【不做摘要】摘要一次多一次失真机会，而这份文本的全部价值在于它是权威原文。
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await provider.retrieve({ query: '退货时限', topK: 1 })
  const content = results[0].content
  // 表格必须原样带过来 —— 类别与天数的对应关系全靠它
  assert.match(content, /\|\s*服饰鞋包\s*\|\s*apparel\s*\|\s*30 天\s*\|/)
  assert.match(content, /\|\s*数码电子\s*\|\s*digital\s*\|\s*7 天\s*\|/)
  assert.match(content, /\|\s*家用电器\s*\|\s*appliance\s*\|\s*15 天\s*\|/)
})

test('每段开头带章节名与行号，模型看得到', async () => {
  // 引用不走 citation 协议 —— normalizeCitation 要求公开 URL，
  // 没有 url 就返回 null（citation.mjs:21），而 policy 是本机私有文件。
  // 所以出处必须写进 content 本身，让模型能在答复里说出来。
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await provider.retrieve({ query: '退款', topK: 1 })
  assert.match(results[0].content, /^《明远优选零售客服细则》.+（第 \d+ 行起）/)
  assert.match(results[0].source.locator, /^domains\/retail\/policy\.md#L\d+$/)
})

test('六个真实查询的首位命中都对', async () => {
  const cases = [
    ['retail', '退货时限', '退货时限'],
    ['retail', '运费谁承担', '运费'],
    ['retail', '退款多久到账', '退款'],
    ['retail', '什么情况转人工', '转人工'],
    ['airline', '免费行李额', '免费托运行李额'],
    ['airline', '改签手续费', '改签'],
  ]
  for (const [domain, query, expected] of cases) {
    const provider = new PolicyKnowledgeProvider({ domain })
    const { results } = await provider.retrieve({ query, topK: 1 })
    assert.ok(results.length, `${query} 没命中任何章节`)
    assert.ok(
      results[0].metadata.heading.includes(expected),
      `${query} 首位命中「${results[0].metadata.heading}」，期望含「${expected}」`,
    )
  }
})

test('标题命中排在正文命中前面', async () => {
  // 【这条的用例是反证挑出来的，不是想出来的】
  // 我最初写的是「查退货时限时运费会排前面」，反证时摘掉加权，排序一模一样 ——
  // 那个例子是编的，测试是假绿。
  //
  // 实际起作用的是「身份核验」：
  //   无加权  九、转人工  |  一、身份核验     ← 转人工那节正文里反复出现「身份核验」
  //   有加权  一、身份核验  |  九、转人工
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await provider.retrieve({ query: '身份核验', topK: 2 })
  assert.match(results[0].metadata.heading, /身份核验/,
    `首位应是「身份核验」那节，实际是「${results[0].metadata.heading}」`)
})

test('一个 provider 只装一个域', async () => {
  // 【踩过】第一版把两个域都装进来，零售会话查「运费谁承担」时
  // 第二条返回了航空的「免费托运行李额」。
  // 混域不只是排序噪声 —— 零售客服可能拿航空规则答零售问题。
  const retail = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await retail.retrieve({ query: '运费谁承担', topK: 5 })
  for (const result of results) {
    assert.equal(result.metadata.domain, 'retail',
      `零售 provider 返回了 ${result.metadata.domain} 的内容`)
  }
})

test('家具类查不到时限 —— 细则里确实没写', async () => {
  // 这是「不许编造」在检索层的形态：检索给不出家具类的天数，
  // 因为原文里没有。实测模型据此答「政策里没有单独列出类别」，没有编。
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await provider.retrieve({ query: '家具退货时限', topK: 3 })
  const joined = results.map(result => result.content).join('\n')
  assert.ok(!/家具/.test(joined), '细则里不该出现家具类，否则这个用例失去意义')
})

test('空查询返回空，不返回全部章节', async () => {
  // 返回全部等于把整份 policy 塞进上下文，会挤掉对话历史。
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  const { results } = await provider.retrieve({ query: '   ' })
  assert.equal(results.length, 0)
})

test('topK 有上下界', async () => {
  const provider = new PolicyKnowledgeProvider({ domain: 'retail' })
  assert.ok((await provider.retrieve({ query: '退', topK: 0 })).results.length >= 1)
  assert.ok((await provider.retrieve({ query: '退', topK: 99 })).results.length <= 6)
})
