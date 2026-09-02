import { ServiceStateStore } from './state-store.mjs'
import { executeTool } from './tools/registry.mjs'

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

  // surface 必须由调用方传，而且只能是这两个值。
  // 它进 audit 记录 —— 「这个不可逆动作是从哪个面调进来的」
  // 事后从日志推不出来，只能在调用时记下。
  async execute(name, args, { sessionId = 'default', surface = 'backend' } = {}) {
    if (surface !== 'frontend' && surface !== 'backend') {
      throw new TypeError(`Unknown tool surface: ${surface}`)
    }
    return executeTool(name, args, { store: this.store, sessionId, surface })
  }
}
