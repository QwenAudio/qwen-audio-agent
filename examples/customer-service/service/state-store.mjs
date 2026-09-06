import { readFileSync } from 'node:fs'

// 唯一的业务状态源。两个 MCP 面（/mcp/frontend 与 /mcp/backend）都通过
// service.execute() 落到这里 —— 这是「同一个领域可以跨两个工具面，但只保留
// 一份 executor 和状态源」的地基。已实测：前端面写入，后端面立刻读到。
//
// 【为什么整份 db 常驻内存】Demo 要能反复演示，reset() 必须瞬时且彻底。
// 落 SQLite 反而要额外处理「怎么回到初始状态」，而这里 structuredClone 一次就够。

const DOMAIN_FILES = Object.freeze({
  retail: new URL('../domains/retail/db.json', import.meta.url),
  airline: new URL('../domains/airline/db.json', import.meta.url),
})

// 【默认域由环境变量定】一个 service 进程可以同时服务两个域（按 session 分），
// 但「没指定域时给哪个」应该跟着这一组进程的用途走 ——
// CS_DOMAIN=airline 起的那一组，默认就该是航空。
export const DEFAULT_DOMAIN = DOMAIN_FILES[process.env.CS_DOMAIN] ? process.env.CS_DOMAIN : 'retail'

// 【日期要锚到「现在」，不能用文件里的绝对日期】
// db.json 里的 deliveredAt 是写死的。写它那天 #W2094558 是「3 天前签收」，
// 在 digital 类 7 天窗口内；一个星期之后它变成 8 天，退货测试就红了，
// 而代码一行没改。这个 demo 会随时间腐烂。
//
// 对照组：实测时库里十笔已签收订单的距今天数是
//   5 / 6 / 8 / 9 / 12 / 14 / 27 / 32 / 54 / 82
// 写他们那天本来是 3 / 4 / 6 / 7 / 10 / 12 / 25 / 30 / 52 / 80 ——
// 每过一天全体向后滑一天，早晚跨过 7 天、30 天这些边界。
//
// 解法：在装载时把每个日期字段按「距基准日多少天」平移到今天。
// 基准日写在 db.json 的 _anchorDate 里 —— 那是造这份数据时的「今天」。
// 于是不管哪天跑，相对关系（哪笔在期限内、哪笔超期）都与当时一致。
const DATE_FIELDS = Object.freeze(['placedAt', 'deliveredAt', 'shippedAt', 'bookedAt', 'date'])

function shiftDates(value, offsetMs) {
  if (Array.isArray(value)) return value.map(item => shiftDates(item, offsetMs))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (DATE_FIELDS.includes(key) && typeof item === 'string' && item) {
      const parsed = new Date(item)
      if (Number.isNaN(parsed.getTime())) {
        out[key] = item
      } else {
        const shifted = new Date(parsed.getTime() + offsetMs)
        // 只有日期的字段（航班的 date）保持 YYYY-MM-DD 形式，
        // 否则航段指向航班的那个键会对不上。
        out[key] = /^\d{4}-\d{2}-\d{2}$/.test(item)
          ? shifted.toISOString().slice(0, 10)
          : shifted.toISOString()
      }
    } else {
      out[key] = shiftDates(item, offsetMs)
    }
  }
  return out
}

function anchorToToday(db) {
  const anchor = db._anchorDate
  if (!anchor) return db
  const base = new Date(anchor)
  if (Number.isNaN(base.getTime())) return db
  // 【不取整】按整天平移会让「基准日晚些时候」的时间戳跑到未来：
  // bookedAt 是 9-02 18:00、锚点取 9-02 零点的话，平移五天变成 9-07 18:00，
  // 而现在是 9-06 —— 出票时间在未来，24 小时免费退票那条判定就全乱了。
  // 锚点取「最晚的过去时间戳」并且不取整，那一笔就正好落在「刚刚」。
  const offset = Date.now() - base.getTime()
  if (Math.abs(offset) < 60_000) return db
  return shiftDates(db, offset)
}

function loadDomain(domain) {
  const url = DOMAIN_FILES[domain]
  if (!url) throw new Error(`Unknown domain: ${domain}`)
  try {
    return anchorToToday(JSON.parse(readFileSync(url, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Domain database is missing: ${domain}`)
    }
    throw error
  }
}

export class ServiceStateStore {
  #sessions = new Map()

  #listeners = new Map()

  // 每个 sessionId 一份独立的库。Demo 里同时开两个浏览器标签演示不同场景时，
  // 它们不该互相看见对方改的订单。
  //
  // 【domain 缺省时不能填默认值，要沿用已有会话的域】
  // 第一版签名是 #session(sessionId, domain = 'retail')，于是任何不传 domain
  // 的调用（executor 里到处都是 store.mutable(sessionId)）都会被当成
  // 「要 retail」—— 而下面那个 session.domain !== domain 的判断随即
  // 把航空会话整个重建成零售，身份、订单改动、审计全丢。
  //
  // 现在的语义：显式传 domain 才可能换域，不传就是「给我当前这个会话」。
  #session(sessionId, domain) {
    const id = String(sessionId || '').trim() || 'default'
    let session = this.#sessions.get(id)
    const wanted = domain || session?.domain || DEFAULT_DOMAIN
    if (!session || session.domain !== wanted) {
      session = {
        id,
        domain: wanted,
        version: 0,
        // 身份是【会话级事实】，不是任务级参数：前端核验一次，
        // 后端派活时能直接读到，用户不会被问第二次。
        identity: { verified: false, userId: null, method: null, at: null },
        db: loadDomain(wanted),
        // 每次工具调用一条，给 ActionLog 面板用。它是审计证据，
        // 所以连失败的调用也要记 —— 「未核验身份就查订单」正是靠这个发现的。
        audit: [],
      }
      this.#sessions.set(id, session)
    }
    return session
  }

  snapshot(sessionId, domain) {
    const session = this.#session(sessionId, domain)
    return Object.freeze(structuredClone({
      sessionId: session.id,
      domain: session.domain,
      version: session.version,
      identity: session.identity,
      // 【transferred 要投影出来】它一直没在 snapshot 里 ——
      // executor 写了 session.transferred，但界面和测试都看不到。
      // 「已转人工」是会话的终态之一：转出去之后客服不该再自行办业务，
      // 界面上也该显示出来，否则演示时看不出转接发生了。
      transferred: session.transferred || null,
      db: session.db,
      audit: session.audit,
    }))
  }

  // 供 executor 直接改写。返回的是活引用而不是副本 —— executor 需要就地改。
  mutable(sessionId, domain) {
    return this.#session(sessionId, domain)
  }

  bumpVersion(sessionId) {
    const session = this.#session(sessionId)
    session.version += 1
    this.#publish(session)
    return session.version
  }

  markVerified(sessionId, { userId, method }) {
    const session = this.#session(sessionId)
    session.identity = {
      verified: true,
      userId: String(userId || '') || null,
      method: String(method || '') || null,
      at: Date.now(),
    }
    return this.bumpVersion(sessionId)
  }

  // audit 记录里刻意保留 surface（frontend / backend）：
  // 「这个不可逆动作是从哪个面调进来的」是 §9 配置台要回答的问题，
  // 事后从日志里推不出来，只能在调用时记下。
  appendAudit(sessionId, entry) {
    const session = this.#session(sessionId)
    session.audit.push(Object.freeze({
      at: Date.now(),
      tool: String(entry.tool || ''),
      surface: entry.surface === 'frontend' ? 'frontend' : 'backend',
      ok: entry.ok !== false,
      summary: String(entry.summary || '').slice(0, 200),
      // 违规标记。不阻止执行，只记录 —— 见计划 §8.4：
      // 第 2 层的偏差要可见，而不是消灭。
      warning: entry.warning ? String(entry.warning).slice(0, 200) : null,
    }))
    if (session.audit.length > 200) session.audit.shift()
    this.#publish(session)
    return session.audit.length
  }

  // 一键回到初始状态。Demo 反复演示必需。
  reset(sessionId, domain) {
    const id = String(sessionId || '').trim() || 'default'
    const previous = this.#sessions.get(id)
    this.#sessions.delete(id)
    const session = this.#session(id, domain || previous?.domain || DEFAULT_DOMAIN)
    this.#publish(session)
    return session.version
  }

  // 切换到「另一位客户」。
  //
  // 【为什么不换 sessionId 而是重绑】
  // sessionId 在网关启动时被烘进 CS_FRONTEND_MCP_URL
  // （见 gateway/server.mjs 里的说明：MCP 客户端用的是静态 transport.headers，
  // 框架不按会话注入参数）。所以换 sessionId 只会换掉 WebSocket 那一侧 ——
  // 模型的前台工具还打在原来那个会话上，它会看到「尚未核验」而客户
  // 明明刚核验过。
  //
  // 重绑的语义：同一个 sessionId 背后换一份全新的库。对模型和 MCP 完全透明。
  //
  // 【它清不掉对话历史】那份在网关的 .runtime/sessions/<sessionId>/ 里，
  // 而网关没有清空接口（只有三个 GET）。所以返回值里带 conversationRetained，
  // 让界面能明说「模型还记得刚才聊过什么」，而不是假装换了个新客户。
  newCustomer(sessionId, domain) {
    const id = String(sessionId || '').trim() || 'default'
    const previous = this.#sessions.get(id)
    const wanted = domain || previous?.domain || DEFAULT_DOMAIN
    this.#sessions.delete(id)
    const session = this.#session(id, wanted)
    // 序号从上一份接着走，这样界面的 SSE 能察觉到变化 ——
    // 归零的话订阅方看到 version 变小，可能当成乱序丢弃。
    session.version = (previous?.version || 0) + 1
    this.#publish(session)
    return {
      version: session.version,
      domain: session.domain,
      conversationRetained: true,
    }
  }

  subscribe(sessionId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const id = String(sessionId || '').trim() || 'default'
    const listeners = this.#listeners.get(id) || new Set()
    listeners.add(listener)
    this.#listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#listeners.delete(id)
    }
  }

  #publish(session) {
    const listeners = this.#listeners.get(session.id)
    if (!listeners?.size) return
    const payload = this.snapshot(session.id)
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        // 一个订阅者抛错不该影响其它订阅者，也不该让工具调用失败。
      }
    }
  }
}
