// Session-end automatic memory extraction (P0 of the invisible-memory design,
// issue #92). After a voice connection closes, a lightweight text model reads
// the session transcript and proposes durable personal facts. The pipeline is
// deliberately conservative — the voice-only product has no confirmation UI,
// so correctness comes from writing conservatively, easy voice-native
// correction, and the audit trail, never from asking the user.
//
// Code-level safety invariants (do not weaken):
// - Writes go to the facts data scope only. rules (directives) and profile
//   accept explicit memory tool writes exclusively.
// - Every automatic write is tagged source: 'inferred' so it can be bulk
//   reverted without touching explicit memories.
// - Failures are silent: extraction must never delay or break session close,
//   and must never produce speech.

const FACTS_SCOPE = 'facts'
const MAX_OPS_PER_RUN = 5
const MAX_FACT_CHARS = 100

// Secondary sensitive-content gate behind the extractor prompt. Conservative
// by design: a false positive drops one candidate fact, a false negative
// persists a secret.
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)/i,
  /(?:密码|密钥|口令|验证码|令牌|证件号|身份证)/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\b\d{11,19}\b/,
  /[A-Za-z0-9+/]{40,}={0,2}/,
]

const EXTRACTOR_SYSTEM_PROMPT = [
  '你是一个记忆提取器，从语音助手与用户的对话转写中提取值得跨会话长期记住的用户个人事实。',
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"ops":[{"action":"add","kind":"stated","content":"用户……"}]}',
  '',
  '规则：',
  '- 只提取用户本人陈述的、稳定的个人事实：身份、称呼、偏好、习惯、人际关系、长期目标或计划。',
  '- kind 只能是 stated 或 inferred：stated 表示用户明确陈述（如"我是、我喜欢、我每天"）；inferred 表示从上下文推测。拿不准时用 inferred。',
  '- 每条 content 不超过 50 字，以"用户"开头，脱离对话也能独立成立。',
  '- 不提取：一次性情绪、临时安排、本次任务的执行细节、助手自身的行为、常识、随时可以再查到的事实。',
  '- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
  '- "已有记忆"里已经覆盖的事实不要重复输出。',
  '- 没有值得记住的内容时输出 {"ops":[]}。',
].join('\n')

function containsSensitiveContent(value) {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(value))
}

function cleanFact(value) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, MAX_FACT_CHARS)
    .join('')
}

// The model may wrap JSON in a Markdown code fence despite instructions.
function parseOps(text) {
  const raw = String(text || '').trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed = JSON.parse(unfenced)
  if (!parsed || !Array.isArray(parsed.ops)) {
    throw new Error('extractor output has no ops array')
  }
  return parsed.ops
}

function transcriptLines(messages, maxChars) {
  const lines = []
  let used = 0
  // Keep the most recent turns when the transcript exceeds the budget.
  for (const message of messages.toReversed()) {
    const content = String(message.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const line = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    if (lines.length && used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
  }
  return lines
}

// Production llmCall factory: one stateless chat-completions request against
// any OpenAI-compatible endpoint (DashScope by default, local Ollama works
// too). Returns null without an API key so the extractor silently disables —
// the voice-only product must degrade without a sound.
export function createExtractorLlmCall({
  baseUrl,
  apiKey,
  model,
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey || !baseUrl || !model) return null
  return async ({ system, user }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`memory extractor request failed: ${response.status}`)
      }
      const payload = await response.json()
      return String(payload?.choices?.[0]?.message?.content || '')
    } finally {
      clearTimeout(timer)
    }
  }
}

export class MemoryExtractor {
  constructor({
    memoryStore,
    conversationSync,
    audit = null,
    llmCall = null,
    logger = console,
    now = () => Date.now(),
    debounceMs = 30 * 60_000,
    minUserMessages = 4,
    maxTranscriptChars = 6000,
  } = {}) {
    this.memoryStore = memoryStore
    this.conversationSync = conversationSync
    this.audit = audit
    this.llmCall = llmCall
    this.logger = logger
    this.now = now
    this.debounceMs = debounceMs
    this.minUserMessages = minUserMessages
    this.maxTranscriptChars = maxTranscriptChars
    this.lastRunAt = new Map()
  }

  enabled() {
    return typeof this.llmCall === 'function' && Boolean(this.memoryStore)
  }

  // Fire-and-forget session-close hook. All gating is synchronous so a
  // skipped run costs nothing; the returned promise is for tests only and
  // never rejects.
  maybeRun({ ownerId, sessionId }) {
    if (!this.enabled()) return null
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) return null
    // Debounce only after a previous run; the first close always qualifies.
    const lastRunAt = this.lastRunAt.get(safeOwnerId)
    if (lastRunAt !== undefined && this.now() - lastRunAt < this.debounceMs) {
      return null
    }
    const messages = this.conversationSync?.list({
      ownerId: safeOwnerId,
      sessionId,
    }) || []
    const userMessages = messages.filter(message => message.role === 'user')
    if (userMessages.length < this.minUserMessages) return null
    this.lastRunAt.set(safeOwnerId, this.now())
    return this.run({ ownerId: safeOwnerId, messages }).catch(error => {
      this.audit?.record({
        op: 'error',
        ownerId: safeOwnerId,
        error: String(error?.message || error),
      })
      this.logger?.warn?.('memory.extract_failed', {
        error: String(error?.message || error),
      })
    })
  }

  async run({ ownerId, messages }) {
    const lines = transcriptLines(messages, this.maxTranscriptChars)
    if (!lines.length) return
    const existing = this.memoryStore.list(ownerId, {
      limit: 64,
      scope: FACTS_SCOPE,
    })
    const user = [
      '## 已有记忆',
      existing.length
        ? existing.map(memory => `- ${memory.content}`).join('\n')
        : '（无）',
      '',
      '## 对话转写',
      lines.join('\n'),
    ].join('\n')
    const ops = parseOps(
      await this.llmCall({ system: EXTRACTOR_SYSTEM_PROMPT, user }),
    )
    const existingValues = new Set(
      existing.map(memory => memory.content.toLocaleLowerCase()),
    )
    let written = 0
    for (const op of ops.slice(0, MAX_OPS_PER_RUN)) {
      const content = cleanFact(op?.content)
      const skip = reason => this.audit?.record({
        op: 'skip', ownerId, reason, content,
      })
      if (!content) continue
      // P0 routes only explicitly stated facts; inferred candidates wait for
      // the P1 corroboration shadow store.
      if (op?.action !== 'add' || op?.kind !== 'stated') {
        skip('not_stated')
        continue
      }
      if (containsSensitiveContent(content)) {
        // Never echo the rejected secret into the audit trail.
        this.audit?.record({ op: 'skip', ownerId, reason: 'sensitive' })
        continue
      }
      if (existingValues.has(content.toLocaleLowerCase())) {
        skip('duplicate')
        continue
      }
      try {
        const memory = this.memoryStore.remember(ownerId, content, {
          scope: FACTS_SCOPE,
          source: 'inferred',
        })
        existingValues.add(memory.content.toLocaleLowerCase())
        written += 1
        this.audit?.record({
          op: 'write',
          ownerId,
          id: memory.id,
          scope: memory.scope,
          source: memory.source,
          content: memory.content,
        })
      } catch (error) {
        // Capacity or persistence failure: skip the rest silently.
        this.audit?.record({
          op: 'error',
          ownerId,
          content,
          error: String(error?.message || error),
        })
        break
      }
    }
    this.logger?.debug?.('memory.extract_completed', {
      ops: ops.length,
      written,
    })
  }
}
