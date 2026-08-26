// Session-end automatic memory extraction (P0 of the invisible-memory design,
// issue #92). After a voice connection closes, a lightweight text model reads
// the session transcript and proposes durable personal facts. The pipeline is
// deliberately conservative — the voice-only product has no confirmation UI,
// so correctness comes from writing conservatively, easy voice-native
// correction, and the audit trail, never from asking the user.
//
// Code-level safety invariants (do not weaken):
// - Every write goes through the same frontend context service as the realtime
//   memory tool. The extractor never writes either Markdown file directly.
// - USER.md accepts only explicit interaction directives; MEMORY.md rejects
//   directive-shaped content.
// - Failures are silent: extraction must never delay or break session close,
//   and must never produce speech.

const MEMORY_DOCUMENTS = new Set(['user', 'memory'])
const MAX_OPS_PER_RUN = 5
const MAX_PATCH_CHARS = 1000

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

// Shared boundary classifier for extractor output. It requires directive-shaped
// content in USER.md and rejects the same content from MEMORY.md.
const USER_PREFERENCE_PATTERNS = [
  /(?:我叫|我的名字|用户姓名|用户身份)/,
  /(?:叫我|称呼我|如何称呼|我的称呼)/,
  /(?:你|助手).{0,12}(?:叫|自称|名字|称为)/,
  /(?:你|助手).{0,12}(?:像|作为|当作).{0,8}(?:朋友|伙伴|老师|教练|秘书|助理)/,
  /(?:回复|回答|说话|表达).{0,12}(?:简短|简洁|详细|展开|正式|随意|语气|风格)/,
  /(?:默认|以后).{0,12}(?:中文|英文|语言|时区|称呼|回复|回答)/,
  /(?:用户)?.{0,8}(?:希望|要求|让|请).{0,8}(?:助手|你).{0,30}(?:每次|每回|始终|总是|以后|默认|开头|结尾|加上|带上|说一句)/,
  /(?:助手|你).{0,20}(?:回复|回答|说话|表达|对话).{0,20}(?:每次|开头|结尾|加上|带上|说)/,
  /(?:每次|每回|以后|默认).{0,12}(?:回复|回答|说话|表达|称呼)/,
  /(?:回复|回答|说话|表达|对话).{0,12}(?:开头|结尾|加上|带上|说一句)/,
  /(?:助手称呼用户|用户称呼助手)/,
]

const EXTRACTOR_SYSTEM_PROMPT = [
  '你维护语音助手的 USER.md 和 MEMORY.md。根据对话转写，对现有普通 Markdown 做一次最小修改。',
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"changes":[{"document":"user 或 memory","edits":[{"old_text":"文档中的精确原文","new_text":"替换后的 Markdown"}],"append":"追加的 Markdown 块"}]}',
  '',
  '规则：',
  '- user 只保存用户本人明确提出、会直接改变未来交互方式的长期指令：称呼、关系、助手在该用户面前的名称、语言、表达风格和默认做法。不得推测。',
  '- memory 只保存用户本人明确陈述、稳定且具有跨会话价值的非交互事实与决定：所在地、习惯、兴趣、人际关系事实、项目、长期目标或计划。不得推测。',
  '- edits 用于更正或删除已有内容；old_text 必须逐字来自对应的现有文档且只出现一次。删除时 new_text 为空。',
  '- append 是追加到对应文档的完整 Markdown 块，可包含多项信息并使用合适的小标题；没有新增时为空字符串。',
  '- 保持文档简洁、自然、可直接由人阅读，不添加 ID、时间戳、来源或 JSON 字段。',
  '- 不提取：一次性情绪、临时安排、本次任务的执行细节、助手自身的行为、常识、随时可以再查到的事实。',
  '- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
  '- 已有内容覆盖的信息不要重复追加；新陈述明确纠正旧内容时用 edits 替换，并清理另一个文档中放错位置或冲突的旧内容。',
  '- 同一文档的修改合并为一个 change，每个 document 最多出现一次。',
  '- 没有值得修改的内容时输出 {"changes":[]}。',
].join('\n')

function containsSensitiveContent(value) {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(value))
}

function belongsToUserPreferences(value) {
  return USER_PREFERENCE_PATTERNS.some(pattern => pattern.test(value))
}

function hasExplicitUserDirective(lines) {
  const userText = lines
    .filter(line => line.startsWith('用户:'))
    .join('\n')
  return [
    /(?:以后|今后|从现在|每次|每回|始终|总是|默认|不要再|别再).{0,40}(?:叫|称呼|回复|回答|说|使用|用|加|带)/,
    /(?:叫我|称呼我|你叫|你以后叫|我叫你)/,
    /(?:我希望|我想让你|请你|你要).{0,40}(?:叫|称呼|回复|回答|说|表达|使用|加|带)/,
    /(?:回复|回答|说话|表达).{0,20}(?:简短|简洁|详细|正式|随意|温柔|慢一点|快一点)/,
  ].some(pattern => pattern.test(userText))
}

function cleanPatch(value) {
  return [...String(value || '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim()]
    .slice(0, MAX_PATCH_CHARS)
    .join('')
}

// The model may wrap JSON in a Markdown code fence or append a short
// explanation despite instructions. Extract exactly the first complete JSON
// object so a harmless suffix cannot discard an otherwise valid memory patch.
function firstJsonObject(value) {
  const start = value.indexOf('{')
  if (start < 0) return value
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      return value.slice(start, index + 1)
    }
  }
  return value
}

function parsePatch(text) {
  const raw = String(text || '').trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed = JSON.parse(firstJsonObject(unfenced))
  if (!parsed || !Array.isArray(parsed.changes)) {
    throw new Error('extractor output has no changes array')
  }
  return parsed.changes.slice(0, 2).map(change => ({
    document: String(change?.document || '').trim().toLowerCase(),
    edits: Array.isArray(change?.edits)
      ? change.edits.slice(0, MAX_OPS_PER_RUN).map(edit => ({
          old_text: cleanPatch(edit?.old_text),
          new_text: cleanPatch(edit?.new_text),
        }))
      : [],
    append: cleanPatch(change?.append),
  }))
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
    memoryService,
    conversationSync,
    audit = null,
    llmCall = null,
    logger = console,
    now = () => Date.now(),
    debounceMs = 30 * 60_000,
    minUserMessages = 4,
    maxTranscriptChars = 6000,
  } = {}) {
    this.memoryService = memoryService
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
    return typeof this.llmCall === 'function' && Boolean(this.memoryService)
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
    const existing = this.memoryService.list(ownerId)
    const documents = new Map(existing.map(document => [document.scope, document]))
    const user = [
      '## 当前 USER.md',
      documents.get('user')?.content || '# USER',
      '',
      '## 当前 MEMORY.md',
      documents.get('memory')?.content || '# MEMORY',
      '',
      '## 对话转写',
      lines.join('\n'),
    ].join('\n')
    const changes = parsePatch(
      await this.llmCall({ system: EXTRACTOR_SYSTEM_PROMPT, user }),
    )
    if (!changes.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'no_change' })
      return
    }
    if (
      changes.some(change => !MEMORY_DOCUMENTS.has(change.document))
      || new Set(changes.map(change => change.document)).size !== changes.length
      || changes.some(change => !change.edits.length && !change.append)
    ) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'invalid_change' })
      return
    }
    const proposed = changes.flatMap(change => [
      ...change.edits.map(edit => edit.new_text),
      change.append,
    ]).join('\n')
    if (containsSensitiveContent(proposed)) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'sensitive' })
      return
    }
    const invalidBoundary = changes.some(change => {
      const additions = [
        ...change.edits.map(edit => edit.new_text),
        change.append,
      ].filter(Boolean).join('\n')
      if (!additions) return false
      return change.document === 'user'
        ? !belongsToUserPreferences(additions)
        : belongsToUserPreferences(additions)
    })
    if (invalidBoundary) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'document_boundary' })
      return
    }
    if (
      changes.some(change => change.document === 'user')
      && !hasExplicitUserDirective(lines)
    ) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'user_directive_not_explicit' })
      return
    }
    const prepared = changes.map(change => ({
      ...change,
      expectedRevision: documents.get(change.document)?.revision || '',
    }))
    try {
      const result = await this.memoryService.apply(ownerId, prepared, {
        source: 'automatic-extraction',
      })
      this.audit?.record({
        op: 'patch',
        ownerId,
        documents: prepared.map(change => change.document),
        changed: result.changed,
        beforeRevisions: Object.fromEntries(prepared.map(change => [
          change.document,
          documents.get(change.document)?.revision || null,
        ])),
        afterRevisions: Object.fromEntries(result.documents.map(document => [
          document.scope,
          document.revision,
        ])),
        edits: prepared.reduce((sum, change) => sum + change.edits.length, 0),
        appended: prepared.some(change => Boolean(change.append)),
      })
      this.logger?.debug?.('memory.extract_completed', {
        documents: prepared.map(change => change.document),
        edits: prepared.reduce((sum, change) => sum + change.edits.length, 0),
        appended: prepared.some(change => Boolean(change.append)),
        changed: result.changed,
      })
    } catch (error) {
      this.audit?.record({
        op: 'error',
        ownerId,
        error: String(error?.message || error),
      })
    }
  }
}
