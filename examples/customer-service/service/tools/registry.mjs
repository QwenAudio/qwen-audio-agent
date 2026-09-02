import { readFileSync } from 'node:fs'
import { executeIdentityTool } from './identity/execute.mjs'
import { executeOrdersTool } from './orders/execute.mjs'
import { executeReturnsTool } from './returns/execute.mjs'

// 【前台工具白名单】判据（计划 §7.2，实测修正版）：
// 一次调用设完一件事、不依赖外部服务、且不涉及不可逆后果。
//
// 核验与只读查询放前台是因为它们是每个流程的前置门，延迟直接影响体验 ——
// 座舱那边 #291 与 ff1928f 两次把低延迟控制往前台移，就是这个道理。
//
// 写库类（取消、退货、换货、改地址）不在这里：它们要走后台，
// 才能用 auth_required 让任务挂起等客户批准。前台工具没有这个机制，
// 确认就只能靠 prompt —— 而那是守不住的（实测身份核验曾 0%）。
export const FRONTEND_TOOL_NAMES = Object.freeze([
  'verify_identity',
  'identity_status',
  'list_orders',
  'get_order',
  'check_variant',
])

// MCP 标准标注 + 一个非标准的 monetaryHint。
// destructiveHint 表达「不可逆」，monetaryHint 表达「涉及钱」——
// 客服场景必须区分这两件事：
//   transfer_to_human  不可逆（会话交出去了）但不涉款
//   modify_address     可以再改回来，也不涉款，但错了货会寄丢
//   cancel_order       不可逆 + 涉款
// 配置台靠这两个字段自动给出「该不该前台直出」的建议。
const READ_ONLY = new Set([
  'identity_status', 'list_orders', 'get_order', 'check_variant',
])
const DESTRUCTIVE = new Set([
  'cancel_order', 'return_items', 'exchange_items', 'transfer_to_human',
])
const MONETARY = new Set([
  'cancel_order', 'return_items', 'exchange_items',
])

function loadManifest(name) {
  return JSON.parse(readFileSync(new URL(`./${name}/manifest.json`, import.meta.url), 'utf8'))
}

function definition(tool) {
  return Object.freeze({
    name: tool.name,
    title: tool.label,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: {
      readOnlyHint: READ_ONLY.has(tool.name),
      destructiveHint: DESTRUCTIVE.has(tool.name),
      monetaryHint: MONETARY.has(tool.name),
    },
  })
}

function toolGroup(name, execute) {
  const manifest = Object.freeze(loadManifest(name))
  // 目录名与 manifest.domain 必须一致：不一致时 registry 能装起来，
  // 但工具名会挂到错误的 executor 上，而那种错误在运行时才炸。
  if (manifest.domain !== name || !Array.isArray(manifest.functions)) {
    throw new Error(`Invalid customer-service tool group manifest: ${name}`)
  }
  if (typeof execute !== 'function') {
    throw new TypeError(`Customer-service tool group ${name} requires an executor`)
  }
  return Object.freeze({
    name,
    manifest,
    execute,
    definitions: Object.freeze(
      manifest.functions.filter(tool => tool.enabled !== false).map(definition),
    ),
  })
}

const GROUPS = Object.freeze([
  toolGroup('identity', executeIdentityTool),
  toolGroup('orders', executeOrdersTool),
  toolGroup('returns', executeReturnsTool),
])

const BY_NAME = new Map()
for (const group of GROUPS) {
  for (const tool of group.definitions) {
    if (BY_NAME.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
    BY_NAME.set(tool.name, group)
  }
}

// 白名单里写了却没实现的工具名，是最容易悄悄留下的错：
// 配置台导出时人手改了名字，registry 这边没跟上，前台就少一个工具而无人察觉。
for (const name of FRONTEND_TOOL_NAMES) {
  if (!BY_NAME.has(name)) {
    throw new Error(`FRONTEND_TOOL_NAMES contains an unregistered tool: ${name}`)
  }
}

export const ALL_TOOL_NAMES = Object.freeze([...BY_NAME.keys()])

// 后台拿完整工具面，前台拿白名单子集 —— 是「全集 + 子集」，
// 不是两个互斥列表。已实测：两个面读写的是同一份状态。
export function toolDefinitions(surface) {
  const all = GROUPS.flatMap(group => group.definitions)
  return surface === 'frontend'
    ? all.filter(tool => FRONTEND_TOOL_NAMES.includes(tool.name))
    : all
}

export function executeTool(name, args, context) {
  const group = BY_NAME.get(name)
  if (!group) throw new Error(`Unknown customer-service tool: ${name}`)
  return group.execute(name, args || {}, context)
}
