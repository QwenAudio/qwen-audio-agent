// 会话内短期压缩策略（two-tier）。
//
// 移植自评测框架 compression_test/core/strategies.py 的
// BaseStrategy → SummaryStrategy → TwoTierStrategy 三层逻辑。
//
// 两级的含义：
//   清嗓线 60% → 先用规则清掉低信息轮次（零模型调用）
//   压缩线 80% → 再走滚动摘要
//
// 消息队列约定：[{ role, content, turn, kind }]，kind 为 'dialog' | 'summary'。
//
// 与评测框架的三处有意差异（都有注释标注）：
//   1) 摘要调用改为注入式回调 summarize()，便于把"触发时现算"换成"后台预抽取"
//   2) token 计数用估算器（Node 侧无 tiktoken），可通过 countTokens 覆盖
//   3) 修正了 rejectBigger 回退路径的数据丢失缺陷（见 compactOnce 内注释）

import {
  CONDENSE_PROMPT,
  SUMMARY_MESSAGE_PREFIX,
  SUMMARY_PROMPT_V2,
} from './summary-prompt.mjs'

// 低信息文本：纯附和、寒暄、语气词。
// 照搬评测框架的表达式。注意它只覆盖英文的 haha/lol —— 中文的「哈哈」「呵呵」
// 「好嘞」等尚未覆盖，属已知缺口，补充需单独评估（会改变清嗓行为）。
const LOW_INFO_RE = new RegExp(
  '^(嗯+|哦+|噢|好的?|好呀|行|可以|没问题|谢谢你?|不客气|okay|ok|sure|yes|no problem|'
  + 'thanks?( you)?|got it|i see|alright|right|yeah|yep|uh-?huh|hmm+|haha+|lol)[。.!！~\\s]*$',
  'i',
)

// 保护名单：命中即绝不清理，优先级高于低信息判定。
// 顺序很重要 —— 「好的，我的电话是138…」必须因为含数字而被保住。
const FACT_RE = /\d|地址|电话|订单|号码|承诺|保证|答应|一定|微信|邮箱|@/

const LOW_INFO_MAX_CHARS = 12

// token 估算：Node 侧没有 tiktoken。中文按字计（1 字 ≈ 1 token），
// 拉丁词按 4 字符 ≈ 1 token。与 cl100k_base 有常数差，但四组策略口径一致，
// 且阈值本身是可调的。需要精确口径时通过 countTokens 传入真实分词器。
export function estimateTokens(value) {
  const text = String(value || '')
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export class CompactionStrategy {
  constructor({
    config,
    // 摘要回调：({ systemPrompt, userMessage }) => Promise<string>
    // 返回空串视为失败（走 truncate 兜底），抛错由调用方处理。
    summarize = null,
    countTokens = estimateTokens,
    summaryPrompt = SUMMARY_PROMPT_V2,
    logger = null,
  } = {}) {
    if (!config) throw new Error('compaction config is required')
    this.config = config
    this.summarize = summarize
    this.countTokens = countTokens
    this.summaryPrompt = summaryPrompt
    this.logger = logger
    this.stats = {
      compactCount: 0,
      clearCount: 0,
      clearedMessages: 0,
      droppedMessages: 0,
      summaryCondensed: 0,
      summaryTruncated: 0,
      summaryLinesDropped: 0,
      summaryRejectedBigger: 0,
      fallbackDropped: 0,
      summarizerFailed: 0,
    }
  }

  // 队列水位。每条消息缓存编码结果，避免逐轮喂入时 O(n^2) 重复计算。
  measure(queue) {
    let total = 0
    for (const message of queue) {
      if (typeof message._tok !== 'number') {
        message._tok = this.countTokens(message.content) + 4
      }
      total += message._tok
    }
    return total
  }

  // queue → [头部摘要区, 可压区, 保护区]
  splitProtected(queue) {
    const rest = [...queue]
    const head = []
    while (rest.length && rest[0].kind === 'summary') {
      head.push(rest.shift())
    }
    const keep = this.config.keepLastMessages
    if (keep && rest.length > keep) {
      return [head, rest.slice(0, rest.length - keep), rest.slice(rest.length - keep)]
    }
    return [head, [], rest]
  }

  // 两级入口。
  async maybeCompress(queue) {
    const total = this.measure(queue)
    if (total >= this.config.compactAt) return this.compactOnce(queue)
    if (total >= this.config.clearAt) return this.throatClear(queue)
    return queue
  }

  isLowInfo(message) {
    const text = String(message?.content || '').trim()
    if (!text) return false
    // 保护名单先行：含数字或事实关键词的一律不清。
    if (FACT_RE.test(text)) return false
    return [...text].length <= LOW_INFO_MAX_CHARS && LOW_INFO_RE.test(text)
  }

  // 清嗓：零模型调用，只清可压区，保护区一条不动。
  throatClear(queue) {
    const [head, mid, tail] = this.splitProtected(queue)
    const kept = []
    let cleared = 0
    for (const message of mid) {
      if (this.isLowInfo(message)) cleared += 1
      else kept.push(message)
    }
    if (cleared) {
      this.stats.clearCount += 1
      this.stats.clearedMessages += cleared
    }
    return [...head, ...kept, ...tail]
  }

  // 摘要长度上限保护：超限先试二次精简，仍超则【按行】截断。
  //
  // 为何必须按行而不能按 token 硬截：V2 台账是"一行一条事实"的结构，
  // 按 token 硬截会砍在行中间，产生「主体 | 类型 | 内容…」这种残行，
  // 模型无法使用且易误读。按行截断能保证每条保留下来的事实都完整，
  // 且模板已把【参与者】【事实台账】排在前、【话题脉络】排在末，
  // 从尾舍弃正好符合优先级。
  async capSummary(summary) {
    const cap = this.config.summaryMax
    if (cap <= 0 || this.countTokens(summary) <= cap) return summary
    let next = summary
    if (this.summarize) {
      try {
        const condensed = await this.summarize({
          systemPrompt: CONDENSE_PROMPT.replace('%d', String(cap * 2)),
          userMessage: summary,
        })
        if (String(condensed || '').trim()) {
          next = condensed
          this.stats.summaryCondensed += 1
        }
      } catch (error) {
        this.logger?.warn?.('compaction.condense_failed', { error: error.message })
      }
    }
    if (this.countTokens(next) <= cap) return next
    const lines = next.split('\n')
    const kept = []
    let used = 0
    for (const line of lines) {
      const cost = this.countTokens(line) + 1
      if (used + cost > cap) break
      kept.push(line)
      used += cost
    }
    this.stats.summaryTruncated += 1
    this.stats.summaryLinesDropped += lines.length - kept.length
    // kept 为空（罕见：首行就超 cap）时退回按字符截，保证不返回空摘要。
    return kept.length ? kept.join('\n') : [...next].slice(0, cap * 2).join('')
  }

  async compactOnce(queue) {
    const [head, mid, tail] = this.splitProtected(queue)
    if (!mid.length) return queue // 只剩保护区，压无可压

    const previousSummary = head.length
      ? head.map(message => message.content).join('\n')
      : ''

    // 从最老开始取溢出轮次，直到预计剩余低于目标水位。
    // 以"摘要上限"估算未来摘要占位，避开用旧摘要体积误判的问题。
    const headBudget = head.length
      ? Math.min(this.config.summaryMax, this.measure(head))
      : 0
    const remaining = [...mid]
    const toSquash = []
    while (
      remaining.length
      && headBudget + this.measure([...remaining, ...tail]) > this.config.target
    ) {
      toSquash.push(remaining.shift())
    }
    if (!toSquash.length) toSquash.push(remaining.shift()) // 至少压一批，避免空转

    const dialogText = toSquash
      .map(message => `[${message.role}] ${message.content}`)
      .join('\n')
    const userMessage = `# 旧摘要\n${previousSummary || '(空)'}\n\n`
      + `# 新增的旧对话轮次\n${dialogText}`

    let summary = ''
    if (this.summarize) {
      try {
        summary = String(await this.summarize({
          systemPrompt: this.summaryPrompt,
          userMessage,
        }) || '').trim()
      } catch (error) {
        this.logger?.warn?.('compaction.summarizer_failed', { error: error.message })
      }
    }

    // 摘要器不可用或返回空：退回截断语义，如实丢弃这一批。
    if (!summary) {
      this.stats.summarizerFailed += 1
      this.stats.compactCount += 1
      this.stats.droppedMessages += toSquash.length
      return this.enforceTarget(head, remaining, tail)
    }

    // 摘要比原文还长 → 拒绝这次摘要。
    //
    // 【与评测框架的差异】评测版此处把 summary 回退成 previousSummary 就返回，
    // 注释写的是"等价于本次不压"，但实际上 toSquash 已经从队列里摘走了 ——
    // 结果是原文被丢弃、却换来一条内容为"(空)"的摘要，该批内容既不在原文也
    // 不在摘要里，形成静默数据丢失（已在远端复现：关键信息电话号凭空消失）。
    //
    // 这里改为真正的"本次不压"：原样返回入参队列，且【不走 enforceTarget】——
    // 因为兜底丢弃会把刚放回去的原文再当成普通溢出丢掉，绕一圈还是丢。
    // 代价是本次水位没降下来；这是有意的：摘要器给不出可用结果时，
    // 宁可让下一轮再试（届时批量更大、更不容易触发本分支），也不静默丢用户内容。
    if (this.countTokens(summary) > this.countTokens(dialogText)) {
      this.stats.summaryRejectedBigger += 1
      return queue
    }

    this.stats.compactCount += 1
    this.stats.droppedMessages += toSquash.length
    const capped = await this.capSummary(summary)
    const newHead = [{
      role: 'system',
      content: `${SUMMARY_MESSAGE_PREFIX}\n${capped}`,
      turn: -1,
      kind: 'summary',
    }]
    return this.enforceTarget(newHead, remaining, tail)
  }

  // 压缩后水位兜底：打断"压了也不降"的死循环。
  // 保护区（tail）永不参与丢弃。
  enforceTarget(head, mid, tail) {
    const remaining = [...mid]
    while (
      remaining.length
      && this.measure([...head, ...remaining, ...tail]) > this.config.target
    ) {
      remaining.shift()
      this.stats.fallbackDropped += 1
      this.stats.droppedMessages += 1
    }
    return [...head, ...remaining, ...tail]
  }
}
