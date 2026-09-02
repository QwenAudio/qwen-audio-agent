// 会话摘要产出器 —— 会话结束时把本场压成 topics + 一句 gist。
//
// 为什么是独立的第三次模型调用，而不是挂到抽取器或观察器上：
//   · 抽取器的立场是「只记用户明说的、不得推测」，它的产出直接进 USER.md /
//     MEMORY.md。摘要是概括，天然带归纳，混进去会磨掉那条边界。
//   · 观察器的产出必须过「quote 逐字来自用户轮」的硬校验，而 gist 是概括、
//     不是原话，永远过不了 —— 为它开一个校验豁免口子，等于把那条防护打穿。
//   · 三者的失败也应当互相隔离：摘要失败不该连带丢掉一次画像观察。
//
// 与另外两条链路一致的纪律：
//   · 同源输入（ConversationSync 的本场转写），不依赖任何会话内压缩机制
//   · 失败静默，绝不延迟或打断会话关闭，绝不发声
//   · 会话过短就不调模型，省掉一次没意义的往返

import { SESSION_DIGEST_LIMITS, normaliseTopics } from './session-digest.mjs'

const SUMMARY_SYSTEM_PROMPT = [
  '你在为语音助手记录「这场对话聊了什么」，供以后用户问起「前几天我们聊的那个」时检索。',
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"topics":["话题"],"gist":"一句话要点"}',
  '',
  '规则：',
  `- topics 是本场真正谈过的话题名，最多 ${SESSION_DIGEST_LIMITS.MAX_TOPICS} 个，每个不超过 ${SESSION_DIGEST_LIMITS.MAX_TOPIC_CHARS} 字。`,
  '- topics 要用用户自己会说出口的词。用户提到专有名词（项目名、工具名、文件名）时优先照用原词，这是以后检索的入口。',
  `- gist 用一句话写清「聊了什么、有没有结论」，不超过 ${SESSION_DIGEST_LIMITS.MAX_GIST_CHARS} 字。`,
  '- 不要写成完整摘要，不要分点，不要复述过程，不要评价用户。',
  '- 助手说了什么不重要，重点是这场围绕什么展开。',
  '- 绝不写入：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
  '- 本场没聊出任何可指认的话题时输出 {"topics":[],"gist":""}。',
].join('\n')

function transcriptLines(messages, maxChars) {
  const lines = []
  let used = 0
  for (const message of [...messages].reverse()) {
    const content = String(message?.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const line = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    if (lines.length && used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
  }
  return lines
}

export class SessionSummariser {
  constructor({
    digestPool,
    conversationSync,
    audit = null,
    llmCall = null,
    logger = console,
    minUserMessages = 4,
    maxTranscriptChars = 6000,
    // 取本场派出去的活。用回调而不是直接注入 taskManager：这里只需要「本场有哪些
    // 任务」这一个能力，让 conversation/ 去依赖 task/ 会把两个领域绑在一起。
    listSessionWork = null,
  } = {}) {
    this.digestPool = digestPool
    this.conversationSync = conversationSync
    this.audit = audit
    this.llmCall = llmCall
    this.logger = logger
    this.minUserMessages = minUserMessages
    this.maxTranscriptChars = maxTranscriptChars
    this.listSessionWork = listSessionWork
  }

  enabled() {
    return typeof this.llmCall === 'function' && Boolean(this.digestPool)
  }

  maybeRun({ ownerId, sessionId }) {
    if (!this.enabled()) return null
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId || !sessionId) return null
    // 重连会让同一场会话触发两次关闭钩子；已经记过就不必再花一次调用。
    if (this.digestPool.has({ ownerId: safeOwnerId, sessionId })) return null
    const messages = this.conversationSync?.list({
      ownerId: safeOwnerId,
      sessionId,
    }) || []
    const userMessages = messages.filter(message => message.role === 'user')
    if (userMessages.length < this.minUserMessages) return null
    return this.run({
      ownerId: safeOwnerId,
      sessionId,
      messages,
      turns: userMessages.length,
    }).catch(error => {
      this.audit?.record({
        op: 'error',
        ownerId: safeOwnerId,
        error: String(error?.message || error),
      })
      this.logger?.warn?.('session_digest.summarise_failed', {
        error: String(error?.message || error),
      })
      return null
    })
  }

  async run({ ownerId, sessionId, messages, turns }) {
    const lines = transcriptLines(messages, this.maxTranscriptChars)
    if (!lines.length) return null

    let parsed
    try {
      const reply = await this.llmCall({
        system: SUMMARY_SYSTEM_PROMPT,
        user: ['## 对话转写', lines.join('\n')].join('\n'),
      })
      parsed = JSON.parse(String(reply || '').replace(/^```(?:json)?|```$/gm, '').trim())
    } catch (error) {
      this.audit?.record({
        op: 'error',
        ownerId,
        error: `会话摘要回复无法解析：${String(error?.message || error)}`,
      })
      return null
    }

    const topics = normaliseTopics(parsed?.topics)
    const gist = String(parsed?.gist || '').replace(/\s+/g, ' ').trim()
    const work = this.collectWork({ ownerId, sessionId })
    // 没话题、没要点、也没派过活，这场就不值得记一条
    if (!topics.length && !gist && !work.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'no_topic' })
      return null
    }

    const digest = this.digestPool.record({
      ownerId,
      sessionId,
      topics,
      gist,
      turns,
      work,
    })
    if (!digest) {
      // 落盘侧也会拒（敏感内容、字段不全），那不是错误，只是没收下。
      this.audit?.record({ op: 'skip', ownerId, reason: 'digest_rejected' })
      return null
    }
    this.audit?.record({
      op: 'observe',
      ownerId,
      scope: 'session_digest',
      reason: 'summarised',
      detail: { topics: digest.topics, turns: digest.turns, work: digest.work.length },
    })
    this.logger?.debug?.('session_digest.recorded', {
      topics: digest.topics.length,
      turns: digest.turns,
      work: digest.work.length,
    })
    return digest
  }

  // 任务台账终态只留 30 天，而摘要留 90 天。把本场派过的活沉淀进摘要，
  // 台账清理后仍答得上「上个月让你做过这件事」——只是届时给不出状态了。
  // 取不到任务不是错误：这条链路失败不该连带丢掉整条摘要。
  collectWork({ ownerId, sessionId }) {
    if (typeof this.listSessionWork !== 'function') return []
    try {
      return this.listSessionWork({ ownerId, sessionId }) || []
    } catch (error) {
      this.logger?.warn?.('session_digest.collect_work_failed', {
        error: String(error?.message || error),
      })
      return []
    }
  }
}

export const SUMMARISER_MARKERS = { SUMMARY_SYSTEM_PROMPT }
