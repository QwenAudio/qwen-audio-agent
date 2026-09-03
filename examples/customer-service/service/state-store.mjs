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

function loadDomain(domain) {
  const url = DOMAIN_FILES[domain]
  if (!url) throw new Error(`Unknown domain: ${domain}`)
  try {
    return JSON.parse(readFileSync(url, 'utf8'))
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
    const session = this.#session(id, domain || previous?.domain || 'retail')
    this.#publish(session)
    return session.version
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
