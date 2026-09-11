import { ServiceStateStore } from './state-store.mjs'
import { executeTool } from './tools/registry.mjs'
import { auditUtterance } from './output-audit.mjs'
import { loadGuards } from './guards.mjs'

// 唯一的执行入口。两个 MCP 面都调这里 —— 这是「同一个领域可以跨两个工具面，
// 但只保留一份 executor 和状态源」的落点。
export class CustomerService {
  constructor({ store = new ServiceStateStore() } = {}) {
    this.store = store
  }

  snapshot(sessionId, domain) {
    return this.store.snapshot(sessionId, domain)
  }

  subscribe(sessionId, listener) {
    return this.store.subscribe(sessionId, listener)
  }

  reset(sessionId, domain) {
    return this.store.reset(sessionId, domain)
  }

  // 切换到另一位客户：同一个 sessionId 背后换一份全新的库。
  // 为什么是重绑而不是换 sessionId，见 state-store.mjs 里那段说明。
  newCustomer(sessionId, domain) {
    return this.store.newCustomer(sessionId, domain)
  }

  // 审计客服【说出去的话】。
  //
  // 【toolOutputs 从审计记录里取，不要让调用方传】
  // 它用来判定「这个数字有没有出处」—— 工具真的返回过的数字不算编。
  // 让界面传的话，它传什么都行 —— 那审计就形同虚设：
  // 模型编了一个数，界面把那个数当成「工具说过的」传回来，就过了。
  //
  // 【取证用 store.toolOutputs，不是 audit 的 summary】
  // 这里原先写的是 (session.audit || []).map(entry => entry.summary)，
  // 注释还断言「summary 就是工具当时返回的话」—— 那句话是错的：
  // summary 是给界面看的动作摘要（"查看 CYR8809"、"列出 3 笔预订"），
  // 而且 appendAudit 把它截到 200 字。
  //
  // 于是 toolOutputs 里从来没有金额，模型说出【任何】金额都被判「没有出处」。
  // 实测：get_reservation 返回过 ￥980.00，客服照实说"980元"仍然报违规。
  // 误报比漏报更坏 —— 满屏红字之后没人再当真，真违规也就淹了。
  auditOutput(sessionId, text) {
    const session = this.store.snapshot(sessionId)
    const guards = loadGuards(session.domain)
    return auditUtterance(text, {
      session,
      guards,
      toolOutputs: this.store.toolOutputs(sessionId),
    })
  }

  // surface 必须由调用方传，而且只能是这两个值。
  // 它进 audit 记录 —— 「这个不可逆动作是从哪个面调进来的」
  // 事后从日志推不出来，只能在调用时记下。
  //
  // 【domain 从会话里取，不从参数取】
  // registry 按域挑工具集，而域是会话的属性 —— 一通电话开始时就定了。
  // 让调用方传 domain 会有个隐患：前台传 retail、后台传 airline，
  // 两边看到不同的工具面而读同一份库。所以这里以会话为准。
  async execute(name, args, { sessionId = 'default', surface = 'backend', domain } = {}) {
    if (surface !== 'frontend' && surface !== 'backend') {
      throw new TypeError(`Unknown tool surface: ${surface}`)
    }
    const session = this.store.mutable(sessionId, domain)
    return executeTool(name, args, {
      store: this.store,
      sessionId,
      surface,
      domain: session.domain,
    })
  }
}
