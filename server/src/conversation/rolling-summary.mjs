// 会话内滚动摘要：后台增量维护「本场会话到目前为止的摘要」。
//
// 它解决两个问题：
//   1) 压缩时用户干等 —— 摘要提前算好，压缩只是取来用，零 LLM 调用
//   2) 长会话中途什么都不记 —— 现有抽取只在会话关闭时跑，三小时会话中途全丢
//
// 「滚动」的含义：同一 owner+session 始终只有一份摘要，被不断覆盖更新，
// 不是攒一堆文件。
//
// 一份产物，四处受益：
//   · 压缩触发时直接取用（CompactionStrategy 的 summarize 回调）
//   · 会话结束喂给 MemoryExtractor（比原始转写信噪比高）
//   · 会话结束喂给偏好观察
//   · 生成会话元数据的 topics / gist
//
// 三条纪律（与设计文档 §6 对齐）：
//   · 只写文件，绝不调用 updateSession() —— 改 instructions 等于改 prompt 前缀，
//     会让整场会话的缓存失效，把省下的压缩延迟赔进去
//   · 硬超时即弃，不重试（best-effort，主链路优先）
//   · 同一 owner+session 串行，避免并发写互相覆盖

const DEFAULT_FIRST_TRIGGER_TOKENS = 10_000
const DEFAULT_STEP_TRIGGER_TOKENS = 5_000
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000

function stateKey(ownerId, sessionId) {
  return `${ownerId}\u0000${sessionId || ''}`
}

function transcriptOf(messages, maxChars) {
  const lines = []
  let used = 0
  // 从最新往回取，保证超长时保留的是最近的内容，然后再翻回时间正序。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = String(message.content || '').trim()
    if (!content) continue
    const line = `[${role}] ${content}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }
  return lines.reverse()
}

export class RollingSummary {
  constructor({
    conversationSync,
    // ({ system, user }) => Promise<string>，与 createExtractorLlmCall 同形状
    llmCall = null,
    summaryPrompt,
    countTokens,
    logger = console,
    now = () => Date.now(),
    firstTriggerTokens = DEFAULT_FIRST_TRIGGER_TOKENS,
    stepTriggerTokens = DEFAULT_STEP_TRIGGER_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTranscriptChars = DEFAULT_MAX_TRANSCRIPT_CHARS,
  } = {}) {
    if (!summaryPrompt) throw new Error('rolling summary prompt is required')
    if (typeof countTokens !== 'function') {
      throw new Error('rolling summary countTokens is required')
    }
    this.conversationSync = conversationSync
    this.llmCall = llmCall
    this.summaryPrompt = summaryPrompt
    this.countTokens = countTokens
    this.logger = logger
    this.now = now
    this.firstTriggerTokens = firstTriggerTokens
    this.stepTriggerTokens = stepTriggerTokens
    this.timeoutMs = timeoutMs
    this.maxTranscriptChars = maxTranscriptChars
    // key → { summary, coveredTokens, updatedAt, inFlight }
    this.states = new Map()
  }

  enabled() {
    return typeof this.llmCall === 'function'
  }

  // 当前已就绪的摘要。压缩触发时走这里，永不阻塞、永不调模型。
  peek({ ownerId, sessionId }) {
    return this.states.get(stateKey(ownerId, sessionId))?.summary || ''
  }

  // 供 CompactionStrategy 使用的 summarize 回调。
  // 有现成摘要就直接返回（零等待）；没有则返回空串，由策略走截断兜底。
  summarizerFor({ ownerId, sessionId }) {
    return async () => this.peek({ ownerId, sessionId })
  }

  // 每轮结束后调用。同步判定是否够水位，不够就立刻返回，成本为零。
  // 返回的 promise 仅供测试等待，永不 reject。
  maybeUpdate({ ownerId, sessionId }) {
    if (!this.enabled()) return null
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) return null
    const key = stateKey(safeOwnerId, sessionId)
    const state = this.states.get(key)
    if (state?.inFlight) return null // 同一会话串行，避免并发覆盖

    const messages = this.conversationSync?.list({
      ownerId: safeOwnerId,
      sessionId,
    }) || []
    if (!messages.length) return null

    const totalTokens = messages.reduce(
      (sum, message) => sum + this.countTokens(message.content || ''),
      0,
    )
    const covered = state?.coveredTokens || 0
    const threshold = covered
      ? covered + this.stepTriggerTokens
      : this.firstTriggerTokens
    if (totalTokens < threshold) return null

    const next = { ...(state || {}), inFlight: true }
    this.states.set(key, next)
    return this.run({ ownerId: safeOwnerId, sessionId, messages, totalTokens })
      .catch(error => {
        // best-effort：失败不重试、不影响主链路，下一轮水位仍然够时会再试。
        this.logger?.warn?.('rolling_summary.failed', {
          error: String(error?.message || error),
        })
      })
      .finally(() => {
        const current = this.states.get(key)
        if (current) this.states.set(key, { ...current, inFlight: false })
      })
  }

  async run({ ownerId, sessionId, messages, totalTokens }) {
    const lines = transcriptOf(messages, this.maxTranscriptChars)
    if (!lines.length) return
    const key = stateKey(ownerId, sessionId)
    const previous = this.states.get(key)?.summary || ''
    const user = [
      '# 旧摘要',
      previous || '(空)',
      '',
      '# 新增的旧对话轮次',
      lines.join('\n'),
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let summary = ''
    try {
      summary = String(await this.llmCall({
        system: this.summaryPrompt,
        user,
        signal: controller.signal,
      }) || '').trim()
    } finally {
      clearTimeout(timer)
    }
    if (!summary) return

    const current = this.states.get(key) || {}
    this.states.set(key, {
      ...current,
      summary,
      coveredTokens: totalTokens,
      updatedAt: this.now(),
    })
  }

  // 会话结束：交出摘要供下游消费（抽取 / 偏好观察 / gist 生成）。
  //
  // 默认取走即删：若长期保留，每场会话的完整摘要都会留在内存/盘上，
  // 事实上等于开启了「会话元数据档 2」，而那是需要用户显式同意的。
  take({ ownerId, sessionId }) {
    const key = stateKey(ownerId, sessionId)
    const summary = this.states.get(key)?.summary || ''
    this.states.delete(key)
    return summary
  }

  drop({ ownerId, sessionId }) {
    this.states.delete(stateKey(ownerId, sessionId))
  }
}
