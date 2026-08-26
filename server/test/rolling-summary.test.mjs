import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompactionConfig } from '../src/conversation/compaction-config.mjs'
import {
  CompactionStrategy,
  estimateTokens,
} from '../src/conversation/compaction-strategy.mjs'
import { RollingSummary } from '../src/conversation/rolling-summary.mjs'
import { SUMMARY_PROMPT_V2 } from '../src/conversation/summary-prompt.mjs'

function syncStub(messages = []) {
  return {
    messages,
    list() {
      return this.messages
    },
  }
}

function say(content, role = 'user') {
  return { role, content }
}

// 造出指定 token 量的一条消息（估算器下中文 1 字 ≈ 1 token）
function bulk(tokens, role = 'user') {
  return say('话'.repeat(tokens), role)
}

function rolling(options = {}) {
  const { messages = [], llmCall = async () => '摘要内容', ...rest } = options
  const sync = syncStub(messages)
  const summary = new RollingSummary({
    conversationSync: sync,
    llmCall,
    summaryPrompt: SUMMARY_PROMPT_V2,
    countTokens: estimateTokens,
    logger: { warn() {} },
    ...rest,
  })
  return { summary, sync }
}

test('stays disabled without an llmCall so it costs nothing', () => {
  const { summary } = rolling({ llmCall: null, messages: [bulk(50_000)] })
  assert.equal(summary.enabled(), false)
  assert.equal(summary.maybeUpdate({ ownerId: 'u1' }), null)
  assert.equal(summary.peek({ ownerId: 'u1' }), '')
})

test('waits for the first trigger threshold before calling the model', async () => {
  let calls = 0
  const { summary, sync } = rolling({
    firstTriggerTokens: 100,
    llmCall: async () => { calls += 1; return '台账 v1' },
  })

  sync.messages = [bulk(50)]
  assert.equal(summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' }), null)
  assert.equal(calls, 0)

  sync.messages = [bulk(50), bulk(60)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(calls, 1)
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '台账 v1')
})

test('re-runs only after another step of growth', async () => {
  let calls = 0
  const { summary, sync } = rolling({
    firstTriggerTokens: 100,
    stepTriggerTokens: 50,
    llmCall: async () => { calls += 1; return `台账 v${calls}` },
  })

  sync.messages = [bulk(120)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(calls, 1)

  // 只长了 20 token，未达步进阈值
  sync.messages = [bulk(120), bulk(20)]
  assert.equal(summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' }), null)
  assert.equal(calls, 1)

  // 再长到超过 covered + step
  sync.messages = [bulk(120), bulk(60)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(calls, 2)
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '台账 v2')
})

test('passes the previous summary back in so the ledger accumulates', async () => {
  const seen = []
  const { summary, sync } = rolling({
    firstTriggerTokens: 50,
    stepTriggerTokens: 50,
    llmCall: async ({ system, user }) => {
      seen.push({ system, user })
      return `台账 ${seen.length}`
    },
  })

  sync.messages = [bulk(60)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  sync.messages = [bulk(60), bulk(60)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })

  assert.equal(seen.length, 2)
  assert.match(seen[0].system, /对话记忆台账维护器/)
  assert.match(seen[0].user, /# 旧摘要\n\(空\)/)
  // 第二次把上一轮结果带回去
  assert.match(seen[1].user, /# 旧摘要\n台账 1/)
})

test('serialises per session so concurrent turns cannot overwrite each other', async () => {
  let calls = 0
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    llmCall: async () => { calls += 1; await gate; return '台账' },
  })
  sync.messages = [bulk(50)]

  const first = summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  // 前一次仍在飞行中，第二次必须直接跳过
  assert.equal(summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' }), null)
  release()
  await first
  assert.equal(calls, 1)
})

test('keeps different sessions independent', async () => {
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    llmCall: async () => '台账',
  })
  sync.messages = [bulk(50)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '台账')
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's2' }), '')
  assert.equal(summary.peek({ ownerId: 'u2', sessionId: 's1' }), '')
})

test('never rejects when the summarizer fails, and retries on the next turn', async () => {
  let calls = 0
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    stepTriggerTokens: 10,
    llmCall: async () => {
      calls += 1
      if (calls === 1) throw new Error('upstream timeout')
      return '台账 ok'
    },
  })
  sync.messages = [bulk(50)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' }) // 不抛
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '')

  // 失败没有推进 coveredTokens，下一轮同样水位仍会重试
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(calls, 2)
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '台账 ok')
})

test('ignores an empty model response instead of storing it', async () => {
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    llmCall: async () => '   ',
  })
  sync.messages = [bulk(50)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '')
})

test('keeps the most recent turns when the transcript exceeds the cap', async () => {
  let captured = ''
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    maxTranscriptChars: 30,
    llmCall: async ({ user }) => { captured = user; return '台账' },
  })
  sync.messages = [
    say('最老的一句应当被丢掉因为超出了转写上限'),
    say('中间的一句'),
    say('最新的一句'),
  ]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })
  assert.match(captured, /最新的一句/)
  assert.doesNotMatch(captured, /最老的一句/)
  // 保留下来的部分仍是时间正序
  assert.equal(captured.indexOf('中间的一句') < captured.indexOf('最新的一句'), true)
})

test('take() hands the summary to downstream once and then drops it', async () => {
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    llmCall: async () => '给下游用的台账',
  })
  sync.messages = [bulk(50)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })

  assert.equal(summary.take({ ownerId: 'u1', sessionId: 's1' }), '给下游用的台账')
  // 用完即删 —— 否则等于悄悄开启了「会话摘要长期留存」
  assert.equal(summary.peek({ ownerId: 'u1', sessionId: 's1' }), '')
  assert.equal(summary.take({ ownerId: 'u1', sessionId: 's1' }), '')
})

test('feeds compaction with zero model calls once a summary is ready', async () => {
  const { summary, sync } = rolling({
    firstTriggerTokens: 10,
    llmCall: async () => '【事实台账】\n林舟 | 地点 | 住杭州西湖区 | -',
  })
  sync.messages = [bulk(50)]
  await summary.maybeUpdate({ ownerId: 'u1', sessionId: 's1' })

  let compactionCalls = 0
  const ready = summary.summarizerFor({ ownerId: 'u1', sessionId: 's1' })
  const compaction = new CompactionStrategy({
    config: createCompactionConfig({ windowTokens: 180, keepLastMessages: 2 }),
    summarize: async payload => { compactionCalls += 1; return ready(payload) },
  })
  const queue = [
    '我叫林舟，住杭州西湖区文三路一百号，平时做语音识别相关的工作，这句要够长。',
    '记住了，我会把这些信息保存下来供以后使用，需要时你随时可以问我。',
    '再补一句用来填充窗口的内容，让水位确实越过压缩线而不是只到清嗓线。',
    '好的，我已经记录下来了，你还有别的事情要交代吗。',
    '保护区一',
    '保护区二',
  ].map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    turn: index,
    kind: 'dialog',
  }))

  const output = await compaction.maybeCompress(queue)
  assert.equal(compactionCalls, 1)
  assert.equal(output[0].kind, 'summary')
  assert.match(output[0].content, /住杭州西湖区/)
  assert.equal(compaction.stats.compactCount, 1)
})

test('lets compaction fall back to truncation when no summary is ready', async () => {
  const { summary } = rolling({ firstTriggerTokens: 999_999 })
  const ready = summary.summarizerFor({ ownerId: 'u1', sessionId: 's1' })
  const compaction = new CompactionStrategy({
    config: createCompactionConfig({ windowTokens: 100, keepLastMessages: 2 }),
    summarize: ready,
  })
  const queue = [
    '一句会被丢弃的旧内容，长度需要足够把水位推过压缩线才能进入摘要分支。',
    '好的，这句同样算在水位里，一起把队列推到压缩线以上。',
    '保护区一',
    '保护区二',
  ].map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    turn: index,
    kind: 'dialog',
  }))

  const output = await compaction.maybeCompress(queue)
  assert.equal(compaction.stats.summarizerFailed, 1)
  assert.equal(output.some(message => message.kind === 'summary'), false)
  assert.deepEqual(
    output.slice(-2).map(message => message.content),
    ['保护区一', '保护区二'],
  )
})

test('requires a prompt and a token counter', () => {
  assert.throws(
    () => new RollingSummary({ countTokens: estimateTokens }),
    /prompt is required/,
  )
  assert.throws(
    () => new RollingSummary({ summaryPrompt: 'x' }),
    /countTokens is required/,
  )
})
