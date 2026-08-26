import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompactionConfig } from '../src/conversation/compaction-config.mjs'
import {
  CompactionStrategy,
  estimateTokens,
} from '../src/conversation/compaction-strategy.mjs'

function dialog(pairs) {
  return pairs.map(([role, content], index) => ({
    role,
    content,
    turn: index,
    kind: 'dialog',
  }))
}

function strategy(options = {}) {
  const { windowTokens = 2000, summarize = null, ...rest } = options
  return new CompactionStrategy({
    config: createCompactionConfig({ windowTokens, ...rest }),
    summarize,
  })
}

test('derives thresholds from the empirically verified ratios', () => {
  const config = createCompactionConfig({ windowTokens: 8000 })
  // 与远端评测框架实测一致：clear 4800 / compact 6400 / target 4000 / summaryMax 2000
  assert.equal(config.clearAt, 4800)
  assert.equal(config.compactAt, 6400)
  assert.equal(config.target, 4000)
  assert.equal(config.summaryMax, 2000)
  assert.equal(config.keepLastMessages, 8)
})

test('treats filler as low-info but protects anything carrying a fact', () => {
  const compaction = strategy()
  for (const text of ['嗯', '好的', 'okay', '谢谢你', '行', 'hmm']) {
    assert.equal(compaction.isLowInfo({ content: text }), true, text)
  }
  // 保护名单优先于低信息判定 —— 顺序颠倒会丢掉关键信息
  for (const text of [
    '好的，我的电话是13812345678',
    '嗯，订单号多少',
    '我答应你明天去',
    '我喜欢在周末去海边露营',
  ]) {
    assert.equal(compaction.isLowInfo({ content: text }), false, text)
  }
})

test('throat-clears only the compressible span and never the protected tail', () => {
  const compaction = strategy({ keepLastMessages: 4 })
  const queue = dialog([
    ['user', '嗯'],
    ['user', '我住在朝阳区'],
    ['user', '好的'],
    ['user', '嗯'],
    ['user', '保护区一'],
    ['user', '保护区二'],
    ['user', '保护区三'],
    ['user', '好的'], // 在保护区内，即使是低信息也不清
  ])
  const output = compaction.throatClear(queue)
  assert.equal(compaction.stats.clearedMessages, 3)
  assert.deepEqual(
    output.slice(-4).map(message => message.content),
    ['保护区一', '保护区二', '保护区三', '好的'],
  )
})

test('replaces the squashed span with a rolling summary', async () => {
  const calls = []
  const compaction = strategy({
    windowTokens: 200,
    keepLastMessages: 2,
    summarize: async payload => {
      calls.push(payload)
      return '【事实台账】\n林舟 | 地点 | 住杭州西湖区 | -'
    },
  })
  const queue = dialog([
    ['user', '我叫林舟，住杭州西湖区文三路一百号，平时在公司做语音识别相关的工作，这句话要足够长以便把水位推过压缩线。'],
    ['assistant', '记住了，我会把这些信息保存下来供以后使用，需要的时候你随时可以问我。'],
    ['user', '再说一句用来填充窗口的内容，让整个队列的水位确实越过压缩线而不是只到清嗓线。'],
    ['assistant', '好的，我已经记录下来了，你还有别的事情要交代吗。'],
    ['user', '保护区一'],
    ['assistant', '保护区二'],
  ])
  assert.equal(compaction.measure(queue) >= compaction.config.compactAt, true, '语料需越过压缩线')
  const output = await compaction.maybeCompress(queue)

  assert.equal(calls.length, 1)
  assert.match(calls[0].systemPrompt, /对话记忆台账维护器/)
  assert.match(calls[0].userMessage, /# 旧摘要/)
  assert.match(calls[0].userMessage, /# 新增的旧对话轮次/)
  assert.equal(output[0].kind, 'summary')
  assert.match(output[0].content, /\[历史对话记忆摘要\]/)
  assert.match(output[0].content, /住杭州西湖区/)
  assert.equal(compaction.stats.compactCount, 1)
  // 保护区原样留在末尾
  assert.deepEqual(
    output.slice(-2).map(message => message.content),
    ['保护区一', '保护区二'],
  )
})

test('keeps the原文 when a summary would be larger, instead of losing it', async () => {
  // 评测框架此处会丢弃原文并写入一条内容为"(空)"的摘要（已复现的静默数据丢失）。
  // 迁移版必须真正做到"本次不压"。
  const compaction = strategy({
    windowTokens: 100,
    keepLastMessages: 2,
    summarize: async () => '这条摘要故意写得比被压缩的原文更长'.repeat(20),
  })
  const queue = dialog([
    ['user', '我的电话是13812345678，请一定记住这个号码，后面可能会用到它来联系我。'],
    ['assistant', '好的，我已经把这个号码记下来了，需要时会用它联系你。'],
    ['user', '保护区一'],
    ['assistant', '保护区二'],
  ])
  assert.equal(compaction.measure(queue) >= compaction.config.compactAt, true, '语料需越过压缩线')
  const output = await compaction.maybeCompress(queue)

  assert.equal(compaction.stats.summaryRejectedBigger, 1)
  assert.equal(compaction.stats.compactCount, 0)
  // 不产生摘要消息
  assert.equal(output.some(message => message.kind === 'summary'), false)
  // 关键信息仍在原文里 —— 这是本用例的核心
  assert.equal(
    output.some(message => message.content.includes('13812345678')),
    true,
    '关键信息不得在拒绝摘要时丢失',
  )
  // 一条都不丢：拒绝摘要时不做兜底丢弃，否则放回去的原文会被再丢一次
  assert.equal(output.length, queue.length)
  assert.equal(compaction.stats.droppedMessages, 0)
  assert.equal(compaction.stats.fallbackDropped, 0)
})

test('falls back to truncation when the summarizer is unavailable', async () => {
  const compaction = strategy({
    windowTokens: 100,
    keepLastMessages: 2,
    summarize: async () => { throw new Error('upstream down') },
  })
  const queue = dialog([
    ['user', '一句会被丢弃的旧内容，长度需要足够把水位推过压缩线才能进入摘要分支。'],
    ['assistant', '好的，这句同样算在水位里，一起把队列推到压缩线以上。'],
    ['user', '保护区一'],
    ['assistant', '保护区二'],
  ])
  assert.equal(compaction.measure(queue) >= compaction.config.compactAt, true, '语料需越过压缩线')
  const output = await compaction.maybeCompress(queue)
  assert.equal(compaction.stats.summarizerFailed, 1)
  assert.equal(output.some(message => message.kind === 'summary'), false)
  assert.deepEqual(
    output.slice(-2).map(message => message.content),
    ['保护区一', '保护区二'],
  )
})

test('caps an oversized summary by whole lines, never mid-line', async () => {
  const compaction = strategy({ windowTokens: 400 })
  const lines = Array.from({ length: 40 }, (_, index) => (
    `林舟 | 经历 | 第${index}条足够长的事实内容用来撑开台账体积 | 2026-08-${index % 28 + 1}`
  ))
  const capped = await compaction.capSummary(lines.join('\n'))

  assert.equal(compaction.stats.summaryTruncated, 1)
  assert.equal(estimateTokens(capped) <= compaction.config.summaryMax, true)
  // 每一行都必须是完整的四列，不能出现被砍断的残行
  for (const line of capped.split('\n')) {
    assert.equal(line.split('|').length, 4, `残行: ${line}`)
  }
})

test('drops the oldest compressible messages when the summary alone misses target', async () => {
  const compaction = strategy({
    windowTokens: 80,
    keepLastMessages: 2,
    summarize: async () => '【事实台账】\n林舟 | 属性 | 摘要本身也占据不少水位空间 | -',
  })
  const queue = dialog([
    ['user', '第一句较长的旧内容用于制造超出目标水位的局面。'],
    ['assistant', '第二句同样较长的旧内容继续抬高水位。'],
    ['user', '第三句还是旧内容。'],
    ['assistant', '第四句旧内容。'],
    ['user', '保护区一'],
    ['assistant', '保护区二'],
  ])
  const output = await compaction.maybeCompress(queue)
  assert.equal(compaction.measure(output) <= compaction.config.target, true)
  assert.deepEqual(
    output.slice(-2).map(message => message.content),
    ['保护区一', '保护区二'],
  )
})

test('leaves the queue untouched below the clear line', async () => {
  const compaction = strategy({ windowTokens: 8000 })
  const queue = dialog([['user', '嗯'], ['assistant', '好的']])
  const output = await compaction.maybeCompress(queue)
  assert.deepEqual(output, queue)
  assert.equal(compaction.stats.clearCount, 0)
  assert.equal(compaction.stats.compactCount, 0)
})

test('estimates CJK by character and latin by word chunk', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello'), 2)
  assert.equal(estimateTokens(''), 0)
})
