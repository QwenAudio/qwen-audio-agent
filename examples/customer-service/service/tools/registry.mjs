import { readFileSync } from 'node:fs'
import { executeIdentityTool } from './identity/execute.mjs'
import { executeOrdersTool } from './orders/execute.mjs'
import { executeReturnsTool } from './returns/execute.mjs'
import { executeReservationsTool } from './reservations/execute.mjs'

// 【工具集按域组装】
// 第一版是全局单例：GROUPS 写死三组，两个域看到同一份工具面。
// 那在只有零售时没问题，加了航空就错了 —— 航空客服不该有 return_items，
// 零售客服不该有 update_baggages。模型看到用不上的工具会去试，
// 而试完发现数据对不上，这种失败很难归因。
//
// identity 是唯一跨域共用的组：工具名相同（verify_identity），
// 判据按 session.domain 在 execute 里分支。理由见 identity/execute.mjs。

// 【前台工具白名单】判据（实测修正版）：
// 一次调用设完一件事、不依赖外部服务、且不涉及不可逆后果。
//
// 核验与只读查询放前台是因为它们是每个流程的前置门，延迟直接影响体验 ——
// 座舱那边 #291 与 ff1928f 两次把低延迟控制往前台移，就是这个道理。
//
// 写库类不在这里：它们要走后台，才能用 auth_required 让任务挂起等客户批准。
// 前台工具没有这个机制，确认就只能靠 prompt —— 而那是守不住的。
const FRONTEND_BY_DOMAIN = Object.freeze({
  retail: Object.freeze([
    'verify_identity',
    'identity_status',
    'list_orders',
    'get_order',
    'check_variant',
  ]),
  airline: Object.freeze([
    'verify_identity',
    'identity_status',
    'list_reservations',
    'get_reservation',
    'get_flight_status',
    // 【search_flights 该在前台 —— 这一条起先漏了】
    // 它只读、单步、不涉款、不可逆，按判据本来就该在这里。
    // 更实际的理由是它决定改签流程有几次挂起：
    //
    //   只在后台  起后台任务 → 搜到三班 → 挂起问客户选哪班 → 恢复
    //            → 预览 → 再挂起等批准        两次挂起
    //   放前台    前台搜完念给客户 → 客户选 → 起后台任务 → 预览
    //            → 只挂起一次（真正需要批准那次）
    //
    // 后台仍然有它（后台是全集），所以放前台不影响改签本身。
    'search_flights',
  ]),
})

// 兼容旧引用：console/surfaces.mjs 与几处测试按这个名字取零售白名单。
// 【不删掉它】改成分域之后仍有代码只关心零售，留一个显式的别名
// 比让它们各自写 FRONTEND_BY_DOMAIN.retail 清楚。
export const FRONTEND_TOOL_NAMES = FRONTEND_BY_DOMAIN.retail

// MCP 标准标注 + 一个非标准的 monetaryHint。
// destructiveHint 表达「不可逆」，monetaryHint 表达「涉及钱」——
// 客服场景必须区分这两件事：
//   transfer_to_human  不可逆（会话交出去了）但不涉款
//   modify_address     可以再改回来，也不涉款，但错了货会寄丢
//   cancel_order       不可逆 + 涉款
// 配置台靠这两个字段自动给出「该不该前台直出」的建议。
const READ_ONLY = new Set([
  'identity_status', 'list_orders', 'get_order', 'check_variant',
  'list_reservations', 'get_reservation', 'get_flight_status', 'search_flights',
])
const DESTRUCTIVE = new Set([
  'cancel_order', 'return_items', 'exchange_items', 'transfer_to_human',
  'cancel_reservation', 'update_flights', 'update_cabin',
])
const MONETARY = new Set([
  'cancel_order', 'return_items', 'exchange_items',
  'cancel_reservation', 'update_flights', 'update_cabin', 'update_baggages',
  'send_certificate',
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

const identityGroup = toolGroup('identity', executeIdentityTool)

// 每个域一组工具。identity 两边都有。
const GROUPS_BY_DOMAIN = Object.freeze({
  retail: Object.freeze([
    identityGroup,
    toolGroup('orders', executeOrdersTool),
    toolGroup('returns', executeReturnsTool),
  ]),
  airline: Object.freeze([
    identityGroup,
    toolGroup('reservations', executeReservationsTool),
  ]),
})

const BY_NAME_BY_DOMAIN = new Map()
for (const [domain, groups] of Object.entries(GROUPS_BY_DOMAIN)) {
  const byName = new Map()
  for (const group of groups) {
    for (const tool of group.definitions) {
      if (byName.has(tool.name)) {
        throw new Error(`Duplicate tool name in ${domain}: ${tool.name}`)
      }
      byName.set(tool.name, group)
    }
  }
  // 白名单里写了却没实现的工具名，是最容易悄悄留下的错：
  // 配置台导出时人手改了名字，registry 这边没跟上，前台就少一个工具而无人察觉。
  for (const name of FRONTEND_BY_DOMAIN[domain] || []) {
    if (!byName.has(name)) {
      throw new Error(`${domain} 的前台白名单里有未注册的工具：${name}`)
    }
  }
  BY_NAME_BY_DOMAIN.set(domain, byName)
}

export const DOMAINS = Object.freeze(Object.keys(GROUPS_BY_DOMAIN))

export function frontendToolNames(domain = 'retail') {
  return FRONTEND_BY_DOMAIN[domain] || FRONTEND_BY_DOMAIN.retail
}

export function allToolNames(domain = 'retail') {
  const byName = BY_NAME_BY_DOMAIN.get(domain)
  return Object.freeze([...(byName?.keys() || [])])
}

// 兼容旧引用。
export const ALL_TOOL_NAMES = allToolNames('retail')

// 后台拿完整工具面，前台拿白名单子集 —— 是「全集 + 子集」，
// 不是两个互斥列表。已实测：两个面读写的是同一份状态。
export function toolDefinitions(surface, domain = 'retail') {
  const groups = GROUPS_BY_DOMAIN[domain] || GROUPS_BY_DOMAIN.retail
  const all = groups.flatMap(group => group.definitions)
  const whitelist = frontendToolNames(domain)
  return surface === 'frontend'
    ? all.filter(tool => whitelist.includes(tool.name))
    : all
}

export function executeTool(name, args, context) {
  const domain = context?.domain || 'retail'
  const byName = BY_NAME_BY_DOMAIN.get(domain) || BY_NAME_BY_DOMAIN.get('retail')
  const group = byName.get(name)
  if (!group) {
    // 【报错要说清是哪个域没有】否则「Unknown tool: return_items」
    // 会让人以为工具没实现，而实际是航空域压根不该有它。
    throw new Error(`${domain} 域没有这个工具：${name}`)
  }
  return group.execute(name, args || {}, context)
}
