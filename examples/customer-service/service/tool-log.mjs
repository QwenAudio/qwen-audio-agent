import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// 工具调用日志。
//
// 【为什么需要它】排查「模型说了会员号，客服却还在问身份」这类问题时，
// /api/service/state 的 audit 只给 summary（工具返回的那句话），
// 看不到【模型到底传了什么参数】—— 而问题往往正在参数上：
// 工具被调了、返回"需要会员号"，说明 memberId 压根没传进来。
// 少了这一份日志，只能靠猜或者反复复现。
//
// 【为什么默认不开】单元测试会把 executeTool 调上千次，默认写盘会让
// 测试目录里凭空长出文件、也拖慢测试。所以由 service/server.mjs 在
// 真正以服务进程启动时才设 CS_TOOL_LOG，库被直接 import 时安静。
//
// 【隐私】参数里有会员号和证件号后四位（库里本来只存后四位，没有完整证件号）。
// 日志落在 .runtime-logs/ 下，被 .gitignore 的 .runtime-*/ 规则挡住，
// 不会随 commit 出去。

let warned = false

function target() {
  return String(process.env.CS_TOOL_LOG || '').trim()
}

export function toolLogPath() {
  return target()
}

// 结果里 content 可能很长（列一堆航班），日志里截断 —— 要看全文去 audit。
function brief(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}…（截断，共 ${text.length} 字）` : text
}

export function logToolCall({ name, args, context, result, error, startedAt }) {
  const path = target()
  if (!path) return
  const line = {
    at: new Date().toISOString(),
    ms: startedAt ? Date.now() - startedAt : null,
    domain: context?.domain || null,
    // 前台=模型直接调，后台=A2A Agent 调。分不清这个，
    // 就分不清是模型的问题还是后台流程的问题。
    surface: context?.surface || null,
    session: context?.sessionId || null,
    tool: name,
    // 【完整参数，不截断】这正是这份日志存在的理由。
    args: args ?? {},
    ...(error
      ? { failed: true, error: String(error?.message || error) }
      : {
          content: brief(result?.content),
          // 【不要自己编 ok】工具的返回值里没有 ok 字段 —— 审计里那个 ok 是
          // 各工具自己调 store.appendAudit 时单独写的（identity/execute.mjs
          // 第 93/108 行两个分支）。在这里推一个 ok 出来只会是个假信号：
          // 核验失败时它照样是 true。真实信号在 data 里（verified: false、
          // blocked: 'over_ceiling'、needsApproval: true 这些）。
          ...(result?.data ? { data: result.data } : {}),
        }),
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(line)}\n`)
  } catch (writeError) {
    // 【日志失败绝不能影响业务】盘满或没权限时，抱怨一次就闭嘴 ——
    // 每次调用都打一行会把真正的错误刷掉。
    if (!warned) {
      warned = true
      console.warn(`工具日志写不进 ${path}：${writeError.message}`)
    }
  }
}
