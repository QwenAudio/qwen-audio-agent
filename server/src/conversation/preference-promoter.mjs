// 偏好晋升器：把候选池里过了三道门的观察结果写进 USER.md。
//
// 两条纪律决定了它的形状：
//
// 1) 物理分区，永不混写
//    USER.md 显式分两段：
//      ## 用户明确要求   ← 只有用户明说才能写，晋升机制【只读不写】
//      ## 观察推断       ← 晋升唯一的写入目标
//    这直接防掉 ChatGPT 被逆向分析出的「层间污染」问题：推断内容会漏进
//    明说区，用户看不出哪条是自己说的、哪条是系统猜的。
//
// 2) 明说恒优先，永不改写用户原话
//    冲突时不覆盖、不删除明说条目。OpenAI 社区对 ChatGPT 的原话抗议是
//    「Saved Memories should remain available, editable, and prioritized over
//    any automatically generated summary」——推断层盖过明说层是产品事故。
//
// 生效时机：写完不刷新当前会话（不调 updateSession），下一个新会话自然带上。
// 既是体验选择（用户刚说过的话本来就在上下文里），也是前缀缓存的必然要求。
// 对 occupation 这类要影响端到端音频模型转写倾向的字段，这一点还是硬性的：
// instructions 必须在音频进来之前就位，会话中途改对已转写的音频无效。

import { isSameFieldLabel, renderLabel } from './preference-candidates.mjs'

const EXPLICIT_HEADING = '## 用户明确要求'
const OBSERVED_HEADING = '## 观察推断'

// 注入到观察区之前的一行声明，让优先级在 prompt 里显式可见，
// 而不是依赖模型自己揣摩两段之间的关系。
const OBSERVED_NOTICE = '<!-- 以下为系统观察推断，权威低于上方用户明确要求；如与其冲突，以上方为准 -->'

const MAX_OBSERVED_ITEMS = 12
const MAX_PROMOTIONS_PER_RUN = 3

function bulletOf(trait) {
  return `- ${String(trait || '').trim()}`
}

// 找出文档里的观察区。返回 { before, items, after }，
// 没有观察区时 items 为空且 after 为空串。
export function splitObservedSection(content) {
  const text = String(content || '')
  const index = text.indexOf(OBSERVED_HEADING)
  if (index < 0) return { before: text.trimEnd(), items: [], after: '' }
  const before = text.slice(0, index).trimEnd()
  const rest = text.slice(index + OBSERVED_HEADING.length)
  // 观察区延续到下一个二级标题为止
  const nextHeading = rest.search(/\n## /)
  const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading)
  const after = nextHeading < 0 ? '' : rest.slice(nextHeading).trimEnd()
  const items = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean)
  return { before, items, after }
}

export function renderObservedSection(items) {
  if (!items.length) return ''
  return [
    OBSERVED_HEADING,
    OBSERVED_NOTICE,
    ...items.map(bulletOf),
  ].join('\n')
}

export class PreferencePromoter {
  constructor({
    memoryService,
    candidatePool,
    audit = null,
    logger = console,
    now = () => Date.now(),
    maxObservedItems = MAX_OBSERVED_ITEMS,
    maxPerRun = MAX_PROMOTIONS_PER_RUN,
  } = {}) {
    this.memoryService = memoryService
    this.candidatePool = candidatePool
    this.audit = audit
    this.logger = logger
    this.now = now
    this.maxObservedItems = maxObservedItems
    this.maxPerRun = maxPerRun
  }

  enabled() {
    return Boolean(this.memoryService && this.candidatePool)
  }

  currentUserDocument(ownerId) {
    const documents = this.memoryService.list(ownerId, { scope: 'user' })
    return documents[0] || null
  }

  // 离线扫描入口。返回本次晋升的条目，便于审计与测试。
  //
  // 是 async 的：MemoryProvider 协议允许 apply() 返回 Promise（远程 provider 就是
  // 异步的），而候选销账必须等写入真的成功 —— 否则写失败时候选已被消费，那条
  // 攒了至少两场会话的证据就永久丢了，且无法重试。
  //
  // 【永不抛错】这条契约保持不变，而且现在更要紧：调用方是会话关闭钩子，
  // 它用同步 try/catch 包着这里。如果这里改成 async 之后还会 reject，
  // 那个 catch 就抓不到了 —— 会从「有日志的失败」变成未处理的 rejection。
  async run({ ownerId }) {
    if (!this.enabled()) return []
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) return []
    try {
      return await this.promote(safeOwnerId)
    } catch (error) {
      this.audit?.record({
        op: 'error',
        ownerId: safeOwnerId,
        error: String(error?.message || error),
      })
      this.logger?.warn?.('memory.promote_failed', {
        error: String(error?.message || error),
      })
      return []
    }
  }

  async promote(ownerId) {
    const promotable = this.candidatePool.promotable(ownerId)
    if (!promotable.length) return []

    const document = this.currentUserDocument(ownerId)
    const content = document?.content || ''
    const { before, items, after } = splitObservedSection(content)

    // 写入前重新校验：黑名单可能在扫描后被更新，明说区里可能已有等价表述。
    // 对标 OpenClaw Deep 阶段「写入前重新载入片段，跳过陈旧或已删除的」。
    const explicitText = before.toLocaleLowerCase()
    let kept = [...items]
    const accepted = []
    for (const slot of promotable) {
      if (accepted.length >= this.maxPerRun) break
      const label = slot.label.trim()
      const key = label.toLocaleLowerCase()
      if (kept.some(item => item.trim().toLocaleLowerCase() === key)) {
        this.candidatePool.markPromoted(ownerId, slot.key)
        continue
      }
      // 明说区已经表达过同一件事：不重复写进观察区，直接标记完成。
      if (explicitText.includes(key)) {
        this.candidatePool.markPromoted(ownerId, slot.key)
        this.audit?.record({
          op: 'skip',
          ownerId,
          reason: 'already_explicit',
          scope: 'user',
        })
        continue
      }
      if (this.candidatePool.blocked(ownerId, slot.field, slot.value)) continue
      // 单槽字段互斥：晋升「回答简短」的同时必须移除旧的「回答详细」，
      // 否则观察区里并存两条相反的偏好，模型只能瞎猜。
      kept = kept.filter(item => !isSameFieldLabel(slot.field, item))
      accepted.push(slot)
    }
    if (!accepted.length) return []

    // 新晋升的排在前面，超出上限则从尾部（最旧）淘汰。
    const nextItems = [
      ...accepted.map(slot => slot.label.trim()),
      ...kept,
    ].slice(0, this.maxObservedItems)

    const sections = [before, renderObservedSection(nextItems), after]
      .filter(Boolean)
    const nextContent = `${sections.join('\n\n')}\n`

    // 必须 await：apply() 允许返回 Promise。写入失败时下面的 markPromoted 一条
    // 都不会执行，候选留在池子里，下一场会话结束再试 —— 这是「宁可晋升晚一点，
    // 也不要证据丢了」。抛出的错由 run() 统一记审计。
    await this.memoryService.apply(ownerId, [{
      document: 'user',
      edits: content
        ? [{ old_text: content.trimEnd(), new_text: nextContent.trimEnd() }]
        : [],
      append: content ? '' : nextContent.trimEnd(),
      expectedRevision: document?.revision || '',
    }])

    // 只有写入成功才销账。顺序不能反 —— 反了就是评审指出的那个数据丢失路径。
    for (const slot of accepted) {
      this.candidatePool.markPromoted(ownerId, slot.key)
      this.audit?.record({
        op: 'append',
        ownerId,
        scope: 'user',
        reason: 'promoted',
        // 记下确认明细，用于回答「为什么记住这条」
        detail: {
          field: slot.field,
          value: slot.value,
          label: slot.label,
          confirm: slot.confirm,
          sessions: slot.sessions.length,
        },
      })
    }
    return accepted
  }

  // 用户在管理界面或语音里否决某条观察：从观察区移除并进黑名单。
  //
  // 定位优先 key，其次 field+value；只拿到界面上那行文本时用 label 反查槽位。
  //
  // 是 async 的，理由同 run()：apply() 允许返回 Promise。这里的顺序也刻意先写
  // 文档再拉黑 —— 反过来的话写入失败会留下「候选已拉黑、文档里那行还在」，
  // 用户看到删除没生效又点一次，而重新晋升的路已经被自己堵死了。
  async reject({ ownerId, key = '', field = '', value = '', label = '' }) {
    if (!this.enabled()) return false
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) return false

    let target = { key, field, value }
    let text = String(label || '').trim()
    if (!target.key && !(target.field && target.value)) {
      if (!text) return false
      const found = this.candidatePool
        .list(safeOwnerId)
        .find(slot => slot.label.trim().toLocaleLowerCase() === text.toLocaleLowerCase())
      if (found) target = { key: found.key, field: found.field, value: found.value }
    }
    if (!text && target.field && target.value) {
      text = renderLabel(target.field, target.value).trim()
    }
    if (!text) return false

    // 拉黑排在前面，而且刻意不受下面「文档里有没有这行」的影响：用户可能否决的是
    // 一条还没晋升的候选（观察区里根本没有它），那时也必须记住「以后别晋升这条」。
    // 一度想把它挪到 apply 之后，那会让上述情况在 kept.length === items.length
    // 处提前返回、拉黑执行不到 —— 是功能回退。
    this.candidatePool.reject({ ownerId: safeOwnerId, ...target })

    const document = this.currentUserDocument(safeOwnerId)
    const content = document?.content || ''
    const { before, items, after } = splitObservedSection(content)
    const needle = text.toLocaleLowerCase()
    const kept = items.filter(item => item.trim().toLocaleLowerCase() !== needle)
    if (kept.length === items.length) return false

    const sections = [before, renderObservedSection(kept), after].filter(Boolean)
    const nextContent = `${sections.join('\n\n')}\n`
    // await：apply() 允许返回 Promise。写入失败时这里抛出，调用方拿不到 true，
    // 而拉黑已经生效且幂等 —— 用户再点一次会重新走 apply，这条路径自愈。
    await this.memoryService.apply(safeOwnerId, [{
      document: 'user',
      edits: [{ old_text: content.trimEnd(), new_text: nextContent.trimEnd() }],
      expectedRevision: document?.revision || '',
    }])
    this.audit?.record({
      op: 'replace',
      ownerId: safeOwnerId,
      scope: 'user',
      reason: 'user_rejected',
    })
    return true
  }

  // 供记忆管理界面使用：观察区逐条列出，带确认明细与可用于否决的定位信息。
  // ChatGPT 的推断层不可见、不可删是它最受诟病的一点，这里必须可见可删。
  listObserved(ownerId) {
    if (!this.enabled()) return []
    const content = this.currentUserDocument(ownerId)?.content || ''
    const { items } = splitObservedSection(content)
    const bySlot = new Map(
      this.candidatePool.list(ownerId).map(slot => [
        slot.label.trim().toLocaleLowerCase(),
        slot,
      ]),
    )
    return items.map(label => {
      const slot = bySlot.get(label.trim().toLocaleLowerCase())
      return {
        label,
        field: slot?.field ?? null,
        value: slot?.value ?? null,
        // 界面用 key 回传否决，避免依赖文本匹配
        key: slot?.key ?? null,
        confirm: slot?.confirm ?? null,
        sessions: slot?.sessions?.length ?? null,
        promotedAt: slot?.resolvedAt ?? null,
      }
    })
  }
}

export const PROMOTER_MARKERS = {
  EXPLICIT_HEADING,
  OBSERVED_HEADING,
  OBSERVED_NOTICE,
}
