export function clean(value) {
  return String(value || '').trim()
}

export function toolResult(content, state, changed, data = {}) {
  return {
    content,
    stateVersion: state.version,
    changed,
    data,
  }
}

// 语音里念不了长列表。返回条数超过 limit 时截断，并把「还有多少条」
// 写进文本 —— 让模型有话可说（「还有 5 个，要听吗」），
// 而不是自己决定念几个。计划 §7.3 的「返回时裁到 3 条」落在这里。
export function truncateForVoice(items, limit = 3) {
  if (items.length <= limit) return { shown: items, rest: 0 }
  return { shown: items.slice(0, limit), rest: items.length - limit }
}

// 曾经这里有个 guardVerified，写死「必须已核验身份」。
// 前置条件已经搬到 domains/*/guards.json，由 guards.mjs 的
// checkPreconditions 求值 —— 管理员改配置就能改变哪些工具需要先核验什么。
// 留这段注释是因为「为什么这个文件里没有权限检查」值得说明。
