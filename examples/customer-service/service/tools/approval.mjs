import { randomUUID } from 'node:crypto'

// 【为什么用「预览 + 令牌」两段式，而不是让模型自己记得先问】
//
// 原本打算让写库工具带一个 user_confirmed 参数，靠 prompt 要求模型
// 「问过客户再填 true」。那守不住 —— 模型可以不问就填 true，
// 我们只能事后在审计里发现，而钱已经退出去了。
//
// 改成两段式：第一次调用只返回预览和一枚令牌，不碰数据库；
// 拿着令牌再调一次才真正执行。模型没有「跳过批准」这个选项 ——
// 它拿不到令牌就执行不了。这把「流程约束」变成了「数据依赖」。
//
// 顺带解决另一件事：预览里的金额由 executor 算，不经模型的手。
// 模型算错退款金额比它不会算更糟。

const TTL_MS = 5 * 60 * 1000

// 令牌绑定「哪个动作 + 哪个对象」，不是一张通用通行证。
// 若只校验令牌本身，模型就能拿「取消 A 单」的批准去取消 B 单。
function fingerprint(action, subject) {
  return `${action}::${subject}`
}

export function createApproval(session, { action, subject, preview, effect }) {
  const token = randomUUID()
  session.pendingApprovals ||= new Map()
  session.pendingApprovals.set(token, {
    fingerprint: fingerprint(action, subject),
    preview,
    effect,
    at: Date.now(),
  })
  prune(session)
  return { token, preview }
}

// 令牌一次性：取出即删。否则一次批准能被重放成多次执行 ——
// 客户同意了一次退款，结果退了三次。
export function consumeApproval(session, { action, subject, token }) {
  prune(session)
  const pending = session.pendingApprovals?.get(token)
  if (!pending) return { error: 'unknown_or_expired' }
  session.pendingApprovals.delete(token)
  if (pending.fingerprint !== fingerprint(action, subject)) {
    return { error: 'mismatched_subject' }
  }
  return { effect: pending.effect, preview: pending.preview }
}

function prune(session) {
  if (!session.pendingApprovals) return
  const now = Date.now()
  for (const [token, pending] of session.pendingApprovals) {
    if (now - pending.at > TTL_MS) session.pendingApprovals.delete(token)
  }
}

// 【给模型的话要说「下一步做什么」，不能只说「参数缺失」】
// 后者会让模型原地重试同一个空调用；前者它会去念给客户听。
export function approvalPrompt(preview, token) {
  return `${preview}\n\n`
    + '以上内容需要客户明确同意才能执行。请把要做的事和金额念给客户，'
    + `得到明确同意后，带上 approval_token="${token}" 再调用一次本工具。`
    + '客户没有明确表示同意时不要调用。'
}

export const APPROVAL_ERROR_TEXT = Object.freeze({
  unknown_or_expired: '这个批准令牌无效或已过期（有效期五分钟）。'
    + '请重新调用一次本工具取得新的预览，向客户复述后再执行。',
  mismatched_subject: '这个批准令牌是为另一笔操作签发的，不能用在这里。'
    + '请针对当前这笔重新取得预览。',
})
