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

// 未核验身份就碰订单数据，是细则第十条点名的违规。
// 【它只负责判定并给出文案，拦不拦由调用方决定】——因为两类偏差的处置不同：
//   · 涉及客户数据的（订单、档案）→ 硬拒，泄露说出去就收不回来
//   · 纯顺序类的（先查款式后查订单）→ 只记录，无害
// 计划 §8.3 第 2 层说「偏差要可见而不是消灭」，指的是后者。
export function guardVerified(session, tool) {
  return session.identity.verified
    ? null
    : `${tool} 在身份未核验时被调用`
}
