// 会话摘要 —— 「你记得前几天我们聊的 xxx 吗」的唯一数据来源。
//
// 现状是这个问题一个字都答不上：ConversationSync 纯内存、会话结束即失，
// ConversationSync 的本场镜像在会话结束时就丢掉了。这里补上那一层。
//
// ★ 只存档 1，不存档 2。
// 每场只留 topics + 一句 gist（硬上限 MAX_GIST_CHARS），刻意不存完整摘要。
// realtime-gateway 关闭钩子里那句注释是这条纪律的出处：留下完整摘要等于
// 「悄悄开启每场会话长期留存」，那需要用户显式同意。所以本模块绝不接受
// 完整摘要作为 gist —— 那种文本长度不受这里控制。
//
// ★ 不注入 instructions，只通过工具按需查。
// 这类数据每场会话都不一样，注进 instructions 等于让 prompt 前缀每场都变，
// 前缀缓存会大面积失效 —— 而前缀稳定性优先于注入量。USER.md / MEMORY.md
// 能静态注入是因为它们相对稳定，会话摘要不是。
//
// 检索刻意做得很浅：去标点后子串匹配，没有分词、没有 BM25、没有向量。
// 前端该记的会话量天然有界（每 owner 上限 MAX_SESSIONS_PER_OWNER），
// 记忆量 ÷ 可返回条数 ≈ 1，不需要排序召回。要更深的检索就该丢给后端 Agent。

import { containsSensitiveContent } from '../core/sensitive-content.mjs'
import { JsonSnapshotStore } from '../core/json-snapshot-store.mjs'

const FILE_VERSION = 1
const MAX_SESSIONS_PER_OWNER = 60
const MAX_OWNERS = 200
const MAX_TOPICS = 5
const MAX_TOPIC_CHARS = 16
const MAX_GIST_CHARS = 50
const MAX_WORK_ITEMS = 5
const MAX_WORK_OBJECTIVE_CHARS = 40
const RETENTION_MS = 90 * 24 * 60 * 60_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

function text(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

// 匹配前把标点和空白去掉：ASR 转写的标点很随意，用户说「LOCOMO」而记录里
// 是「LOCOMO、压缩评测」，带标点做子串匹配会漏。
function bare(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

// 取用户本地时区下的日历日：用服务器时区算「今天/昨天」跨时区就错一天。
function calendarParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    day: Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day)),
  }
}

// 相对表述给模型念，绝对日期留着回答「具体哪天」。相对表述是主的：
// 绝对日期会逼模型自己算相对关系，语音场景里这一步很容易算错。
export function describeWhen(at, { now = Date.now(), timeZone = 'UTC' } = {}) {
  let current
  let past
  try {
    current = calendarParts(now, timeZone)
    past = calendarParts(at, timeZone)
  } catch {
    current = calendarParts(now, 'UTC')
    past = calendarParts(at, 'UTC')
  }
  const days = Math.round((current.day - past.day) / 86_400_000)
  let when
  if (days <= 0) when = '今天'
  else if (days === 1) when = '昨天'
  else if (days < 7) when = `${days} 天前`
  else if (days < 14) when = '上周'
  else if (days < 30) when = `${Math.floor(days / 7)} 周前`
  else when = `${Math.floor(days / 30)} 个月前`
  return { when, date: past.date, days_ago: Math.max(days, 0) }
}

// 本场派出去的活。刻意只存 id 与 objective，【绝不存 status】——
// 摘要是冻结的事实，任务状态是活的：今天记「进行中」，过几天任务早完成了，
// 存下来的那个值就是错的，而且不报错。状态一律在检索时从任务台账实时读；
// 台账过期（终态 30 天）后就只答「派过这件活」，自然降级。
export function normaliseWork(work) {
  if (!Array.isArray(work)) return []
  const items = []
  for (const item of work) {
    const objective = text(item?.objective, MAX_WORK_OBJECTIVE_CHARS)
    if (!objective) continue
    if (containsSensitiveContent(objective)) continue
    const id = text(item?.id, 120)
    if (id && items.some(existing => existing.id === id)) continue
    items.push(id ? { id, objective } : { objective })
    if (items.length >= MAX_WORK_ITEMS) break
  }
  return items
}

export function normaliseTopics(topics) {
  if (!Array.isArray(topics)) return []
  const seen = []
  for (const item of topics) {
    const topic = text(item, MAX_TOPIC_CHARS)
    if (!topic) continue
    if (containsSensitiveContent(topic)) continue
    if (seen.some(existing => bare(existing) === bare(topic))) continue
    seen.push(topic)
    if (seen.length >= MAX_TOPICS) break
  }
  return seen
}

export class SessionDigestPool {
  constructor({
    filePath = null,
    store = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
    retentionMs = RETENTION_MS,
    maxPerOwner = MAX_SESSIONS_PER_OWNER,
  } = {}) {
    this.store = store || (filePath
      ? new JsonSnapshotStore({
          filePath,
          fileVersion: FILE_VERSION,
          label: '会话摘要',
          requiredKeys: ['owners'],
          now,
          onWarning,
        })
      : null)
    this.now = now
    this.retentionMs = retentionMs
    this.maxPerOwner = maxPerOwner
    this.owners = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) {
      // 别的 Gateway 进程可能也在写同一份文件。
      if (!this.store?.hasChanged()) return
    }
    this.loaded = true
    this.owners = new Map()
    const snapshot = this.store?.load()
    if (!snapshot) return
    for (const [ownerId, digests] of Object.entries(snapshot.owners || {})) {
      if (!Array.isArray(digests)) continue
      const restored = digests
        .map(digest => this.sanitise(digest))
        .filter(Boolean)
      if (restored.length) this.owners.set(String(ownerId), restored)
    }
  }

  // 逐条校验而不是整份信任：手改过或跨版本残留的条目应当被丢弃，而不是带着
  // 半截字段流进工具返回值。
  // work 缺失时给空数组而不是判为无效 —— 它是后加的字段，早先写下的摘要没有它，
  // 这种向后兼容的新增不该升 FILE_VERSION，否则会把已经攒下的摘要全部隔离掉。
  sanitise(digest) {
    const session = text(digest?.session, 120)
    const at = Number(digest?.at)
    if (!session || !Number.isFinite(at) || at <= 0) return null
    const gist = text(digest?.gist, MAX_GIST_CHARS)
    const topics = normaliseTopics(digest?.topics)
    const work = normaliseWork(digest?.work)
    if (!gist && !topics.length && !work.length) return null
    const turns = Number(digest?.turns)
    return {
      session,
      at,
      turns: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0,
      topics,
      gist,
      work,
    }
  }

  save() {
    if (!this.store?.enabled()) return false
    const owners = {}
    for (const [ownerId, digests] of this.owners) {
      if (digests.length) owners[ownerId] = digests
    }
    return this.store.save({ owners })
  }

  // 记一场会话。同一 sessionId 重复记录时覆盖而不是追加 —— 一场会话只该有
  // 一条摘要，重连产生的第二次调用不能把列表灌满。
  record({ ownerId, sessionId, topics, gist, turns, work } = {}) {
    this.load()
    const safeOwnerId = String(ownerId || '')
    const digest = this.sanitise({
      session: sessionId,
      at: this.now(),
      topics,
      gist,
      turns,
      work,
    })
    if (!safeOwnerId || !digest) return null
    if (containsSensitiveContent(digest.gist)) return null

    const digests = this.owners.get(safeOwnerId) || []
    const existing = digests.findIndex(item => item.session === digest.session)
    if (existing >= 0) digests[existing] = digest
    else digests.push(digest)

    digests.sort((left, right) => right.at - left.at)
    this.owners.set(safeOwnerId, digests.slice(0, this.maxPerOwner))
    this.prune()
    this.save()
    return digest
  }

  prune() {
    const cutoff = this.now() - this.retentionMs
    for (const [ownerId, digests] of this.owners) {
      const fresh = digests.filter(digest => digest.at >= cutoff)
      if (fresh.length) this.owners.set(ownerId, fresh)
      else this.owners.delete(ownerId)
    }
    if (this.owners.size <= MAX_OWNERS) return
    // 超过 owner 上限时丢掉最久没有新会话的那些。
    const ranked = [...this.owners.entries()]
      .sort((left, right) => (right[1][0]?.at || 0) - (left[1][0]?.at || 0))
    this.owners = new Map(ranked.slice(0, MAX_OWNERS))
  }

  has({ ownerId, sessionId } = {}) {
    this.load()
    const digests = this.owners.get(String(ownerId || '')) || []
    return digests.some(digest => digest.session === String(sessionId || ''))
  }

  // keyword 为空时返回最近若干场；否则按 topics、gist 与派出去的活做子串匹配。
  // 命中 topics 的排在前面 —— 用户说出口的那个词更可能是话题名。
  // work 里的 objective 也要参与匹配：用户问「上次让你跑的压缩评测」，那个词
  // 可能只出现在任务目标里，没被摘进 topics。
  search({ ownerId, keyword = '', limit = DEFAULT_LIMIT } = {}) {
    this.load()
    this.prune()
    const digests = this.owners.get(String(ownerId || '')) || []
    const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const needle = bare(keyword)
    if (!needle) return digests.slice(0, size)
    const scored = []
    for (const digest of digests) {
      const inTopics = digest.topics.some(topic => bare(topic).includes(needle))
      const inWork = digest.work.some(item => bare(item.objective).includes(needle))
      const inGist = bare(digest.gist).includes(needle)
      if (!inTopics && !inWork && !inGist) continue
      scored.push({ digest, rank: inTopics ? 0 : (inWork ? 1 : 2) })
    }
    return scored
      .sort((left, right) => (left.rank - right.rank) || (right.digest.at - left.digest.at))
      .slice(0, size)
      .map(item => item.digest)
  }

  count(ownerId) {
    this.load()
    return (this.owners.get(String(ownerId || '')) || []).length
  }

  health() {
    return {
      ...(this.store?.health() || { ok: true, persistenceEnabled: false, warning: null }),
      owners: this.owners.size,
    }
  }
}

export const SESSION_DIGEST_LIMITS = Object.freeze({
  MAX_TOPICS,
  MAX_TOPIC_CHARS,
  MAX_GIST_CHARS,
  MAX_WORK_ITEMS,
  MAX_WORK_OBJECTIVE_CHARS,
  MAX_SESSIONS_PER_OWNER,
  RETENTION_MS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
})
