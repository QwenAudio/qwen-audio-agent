import { readFileSync } from 'node:fs'
import { logToolCall } from '../tool-log.mjs'
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
    // 【转人工放前台】客户说「我要人工」时最不该等 ——
    // 而走后台要多一个 A2A 往返。它一次调用设完一件事，
    // 没有可批准的内容（客户的话就是授权），也不涉款。
    'transfer_to_human',
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
    // 转人工两个域都在前台 —— 理由见零售那一段。
    'transfer_to_human',
  ]),
})

// 兼容旧引用：console/surfaces.mjs 与几处测试按这个名字取零售白名单。
// 【不删掉它】改成分域之后仍有代码只关心零售，留一个显式的别名
// 比让它们各自写 FRONTEND_BY_DOMAIN.retail 清楚。
export const FRONTEND_TOOL_NAMES = FRONTEND_BY_DOMAIN.retail

// MCP 标准标注 + 一个非标准的 monetaryHint。
// destructiveHint 表达「不可逆」，monetaryHint 表达「涉及钱」——
// 客服场景必须区分这两件事：
//   modify_address     可以再改回来，也不涉款，但错了货会寄丢
//   cancel_order       不可逆 + 涉款
// 配置台靠这两个字段自动给出「该不该前台直出」的建议。
//
// 【transfer_to_human 不再算 destructive】
// 它曾经标成不可逆，理由是「会话交出去了」。但 destructiveHint 在这套里
// 的作用是「要不要走 auth_required 等客户批准」，而转人工没有可批准的内容 ——
// 客户说「我要人工」本身就是授权。把它当不可逆只会让客户多等一个
// A2A 往返，而那正是他最不耐烦的时候。
const READ_ONLY = new Set([
  'identity_status', 'list_orders', 'get_order', 'check_variant',
  'list_reservations', 'get_reservation', 'get_flight_status', 'search_flights',
])
const DESTRUCTIVE = new Set([
  'cancel_order', 'return_items', 'exchange_items',
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

// 【schema 必须按域生成】identity 组被两个域共用，而 verify_identity 的
// 参数在两个域里不一样（零售=邮箱/姓名+邮编，航空=会员号/姓名+证件后四位）。
// 起先这里不传 domain，两个域拿到的都是零售那套 —— 模型照 schema 只能填
// email，航空域的核验因此【必然失败】，而客服还会照着 description
// 向客户索要「收货地址邮编」。实测复现过，日志里是 args={"email":"CY10023841"}。
function definition(tool, domain) {
  const scoped = tool.byDomain?.[domain]
  if (tool.byDomain && !scoped) {
    // 【加新域时要立刻炸】静默回落到零售就是上面那个 bug 的成因：
    // 表面上工具齐全、调用成功，只有参数是错的，很难往这里查。
    throw new Error(`${tool.name} 没有为域 ${domain} 定义参数（manifest 的 byDomain 缺这一项）`)
  }
  return Object.freeze({
    name: tool.name,
    title: tool.label,
    description: scoped?.description ?? tool.description,
    inputSchema: scoped?.parameters ?? tool.parameters,
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
  const enabled = manifest.functions.filter(tool => tool.enabled !== false)
  return Object.freeze({
    name,
    manifest,
    execute,
    // 【按域各存一份】同一个 group 实例被多个域共用（identity 就是），
    // 所以定义不能在这里固化成一套 —— 那正是航空拿到零售 schema 的原因。
    definitionsFor(domain) {
      return this.definitionsByDomain[domain] || this.definitionsByDomain.retail
    },
    definitionsByDomain: Object.freeze(Object.fromEntries(
      Object.keys(FRONTEND_BY_DOMAIN).map(domain => [
        domain,
        Object.freeze(enabled.map(tool => definition(tool, domain))),
      ]),
    )),
    // 工具【名】与域无关，构建索引时用哪一份都一样 —— 只有 schema 分域。
    names: Object.freeze(enabled.map(tool => tool.name)),
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
    for (const name of group.names) {
      if (byName.has(name)) {
        throw new Error(`Duplicate tool name in ${domain}: ${name}`)
      }
      byName.set(name, group)
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
  // 【必须传 domain】用 group 上固化的那一份会让航空拿到零售的参数 schema。
  const all = groups.flatMap(group => group.definitionsFor(domain))
  const whitelist = frontendToolNames(domain)
  return surface === 'frontend'
    ? all.filter(tool => whitelist.includes(tool.name))
    : all
}

// 【出口审计的取证就在这里落地】审计要判「模型说的这个数字有没有出处」，
// 依据是工具真正返回过什么。这一处是所有工具调用的唯一出口，所以记在这里
// 就覆盖全部工具，不必去改二十多个 appendAudit 调用点。
//
// 起初审计读的是 audit 的 summary —— 那是给界面看的动作摘要（"查看 CYR8809"）
// 且截到 200 字，里面从来没有金额。后果是模型说出【任何】金额都被判违规，
// 而满屏误报之后真违规也就没人看了。
function recordOutput(context, result) {
  const content = result?.content
  if (!content || !context?.store?.recordToolOutput) return
  context.store.recordToolOutput(context.sessionId, content)
}

export function executeTool(name, args, context) {
  const domain = context?.domain || 'retail'
  const byName = BY_NAME_BY_DOMAIN.get(domain) || BY_NAME_BY_DOMAIN.get('retail')
  const group = byName.get(name)
  const startedAt = Date.now()
  const payload = args || {}
  if (!group) {
    // 【报错要说清是哪个域没有】否则「Unknown tool: return_items」
    // 会让人以为工具没实现，而实际是航空域压根不该有它。
    const error = new Error(`${domain} 域没有这个工具：${name}`)
    // 【这条尤其要记】模型调了一个本域不该有的工具，说明工具面配错了
    // 或者模型在凭印象猜工具名 —— 而这种调用查表阶段就抛，
    // 不记的话它在日志里完全没有痕迹，只能从异常堆栈里翻。
    logToolCall({ name, args: payload, context, error, startedAt })
    throw error
  }
  // 【日志包在最外层】所有工具调用都过这里，所以这一处就够。
  // 记的是【模型传进来的原始参数】—— audit 只有工具返回的那句话，
  // 排查"工具被调了却说缺参数"时，看不到参数等于看不到原因。
  let outcome
  try {
    outcome = group.execute(name, payload, context)
  } catch (error) {
    logToolCall({ name, args: payload, context, error, startedAt })
    throw error
  }
  // 【必须原样返回同步值】有工具是同步的，把它包成 Promise 会改变调用语义。
  if (!outcome || typeof outcome.then !== 'function') {
    logToolCall({ name, args: payload, context, result: outcome, startedAt })
    recordOutput(context, outcome)
    return outcome
  }
  return outcome.then(
    result => {
      logToolCall({ name, args: payload, context, result, startedAt })
      recordOutput(context, result)
      return result
    },
    error => {
      logToolCall({ name, args: payload, context, error, startedAt })
      throw error
    },
  )
}
