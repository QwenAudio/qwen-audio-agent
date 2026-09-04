import { toolDefinitions } from '../service/tools/registry.mjs'

// 前后台名单的自动建议。
//
// 【为什么这一项不调模型】判据全部来自 manifest 里已有的事实：
// readOnlyHint / destructiveHint / monetaryHint、参数个数、是否有 approval_token。
// 这些是确定的，用规则推比让模型猜稳定得多 —— 而 order_rules 那边的实测
// 已经说明：能用规则的地方不该交给模型。
//
// 管理员看到的是【建议 + 理由 + 改动后果】，不是一个既成事实。
// 每一条都能被推翻，推翻时会显示那样做的代价。

const FRONTEND = 'frontend'
const BACKEND = 'backend'

// 判据按优先级排列，命中第一条就定。顺序不能随意换：
// 「有金钱后果」必须先于「单步只读」判断，否则一个既涉款又只读的工具
// （假如有）会被误放前台。
const RULES = Object.freeze([
  {
    id: 'needs_approval',
    surface: BACKEND,
    match: tool => hasApprovalToken(tool),
    why: '两段式批准工具。它要通过 auth_required 挂起等客户批准，'
      + '而前台工具没有挂起机制。',
    ifOverridden: '前台直出会绕过 auth_required —— 客户的同意就只能靠 prompt 约束，'
      + '而那守不住（实测身份核验曾 0%）。',
  },
  {
    id: 'monetary',
    surface: BACKEND,
    match: tool => tool.annotations?.monetaryHint,
    why: '涉及金钱。退错款收不回来。',
    ifOverridden: '前台直出意味着没有批准挂起，退款可能在客户没同意时就发生。',
  },
  {
    id: 'destructive',
    surface: BACKEND,
    match: tool => tool.annotations?.destructiveHint,
    why: '不可逆动作。',
    ifOverridden: '前台直出后这个动作一旦执行就无法撤销，而确认只能靠模型自觉。',
  },
  {
    id: 'read_only',
    surface: FRONTEND,
    match: tool => tool.annotations?.readOnlyHint,
    why: '只读查询。放前台省掉一次后台往返，语音里这段延迟客户能感知。',
    ifOverridden: '走后台会有 1~3 秒静默。只读查询在客服通话里很高频，'
      + '每次都等后台会明显拖慢节奏。',
  },
  {
    id: 'single_step_write',
    surface: FRONTEND,
    match: tool => countRequired(tool) <= 2,
    why: '一次调用设完一件事，且不涉及金钱或不可逆后果。',
    ifOverridden: '走后台会有可感知的延迟，但不影响正确性。',
  },
])

function hasApprovalToken(tool) {
  return Boolean(tool.inputSchema?.properties?.approval_token)
}

function countRequired(tool) {
  const required = tool.inputSchema?.required
  return Array.isArray(required) ? required.length : 0
}

export function suggestSurfaces(tools = toolDefinitions(BACKEND)) {
  return tools.map(tool => {
    const rule = RULES.find(entry => entry.match(tool))
    // 兜底走后台：判据都没命中说明这个工具的性质不清楚，
    // 而「不清楚」时放后台只是慢一点，放前台可能绕过保护。
    const chosen = rule || {
      id: 'unknown',
      surface: BACKEND,
      why: '无法从 manifest 判断性质，保守放后台。',
      ifOverridden: '性质不明的工具放前台可能绕过尚未识别的保护。',
    }
    return Object.freeze({
      name: tool.name,
      title: tool.title,
      suggested: chosen.surface,
      ruleId: chosen.id,
      why: chosen.why,
      ifOverridden: chosen.ifOverridden,
      facts: Object.freeze({
        readOnly: Boolean(tool.annotations?.readOnlyHint),
        destructive: Boolean(tool.annotations?.destructiveHint),
        monetary: Boolean(tool.annotations?.monetaryHint),
        requiredParams: countRequired(tool),
        twoPhase: hasApprovalToken(tool),
      }),
    })
  })
}

// 把建议（含管理员的推翻）渲染成 gateway/frontend-mcp.json 的内容。
// overrides 形如 { cancel_order: 'frontend' }。
export function buildFrontendMcp(suggestions, {
  overrides = {},
  serverUrl = '${CS_FRONTEND_MCP_URL}',
} = {}) {
  const tools = {}
  for (const item of suggestions) {
    const surface = overrides[item.name] || item.suggested
    if (surface !== FRONTEND) continue
    tools[item.name] = {
      enabled: true,
      description: item.title || item.name,
    }
  }
  return {
    version: 1,
    servers: {
      'customer-service': {
        enabled: true,
        url: serverUrl,
        tools,
      },
    },
  }
}

// 推翻建议的后果清单。导出配置前显示给管理员 ——
// 让他知道自己在换什么，而不是事后从故障里发现。
export function overrideWarnings(suggestions, overrides = {}) {
  const warnings = []
  for (const item of suggestions) {
    const chosen = overrides[item.name]
    if (!chosen || chosen === item.suggested) continue
    warnings.push({
      name: item.name,
      from: item.suggested,
      to: chosen,
      // 只有「建议后台却被改到前台」才是安全性问题；
      // 反方向（建议前台改到后台）只是性能退化。
      severity: item.suggested === BACKEND && chosen === FRONTEND ? 'risk' : 'slowdown',
      detail: item.ifOverridden,
    })
  }
  return warnings
}
