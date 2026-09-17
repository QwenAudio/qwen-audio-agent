import { readFileSync } from 'node:fs'
import { evaluate, validateTable } from './decision-table.mjs'

// guards.json 的加载与求值入口。executor 通过它做判定 ——
// 这是「管理员改了配置会真的改变行为」的落点。
//
// 【设计上最要紧的一条：漏声明要缺省放行】
// 前几轮曾论证「不做工具级状态机」，理由是前置条件随场景变、硬编码会把
// 场景差异写进工具定义，而且枚举不全时那个场景就不能用了。
// 配置化解决了前两点；第三点靠这条缺省行为解决 ——
// 没在 preconditions 里声明的工具照常执行，只是少一道保护。
// 于是「枚举不全」从「功能缺失」退化成「保护缺失」，代价可接受。

const GUARD_FILES = Object.freeze({
  retail: new URL('../domains/retail/guards.json', import.meta.url),
  airline: new URL('../domains/airline/guards.json', import.meta.url),
})

const EMPTY = Object.freeze({
  version: 0,
  domain: '',
  preconditions: Object.freeze({}),
  decisions: Object.freeze({}),
  enums: Object.freeze({}),
  thresholds: Object.freeze({}),
})

// 不缓存：配置台应用 guards.json 后，下一次工具调用必须立刻看到新规则。
// 文件只有几 KB，一通电话读几次的成本远小于「界面显示应用成功，实际仍跑旧规则」的风险。
// 配置台使用原子 rename 写文件，因此这里不会读到半份 JSON。

// 下划线开头的键是注释，不是配置项。JSON 不支持注释，而这些文件是给人读、
// 给人改的 —— 每张表旁边说明「为什么这么排」比另开一份文档有用。
// 约定成 _ 前缀而不是别的：JSON Schema 生态里这是惯例。
function isComment(key) {
  return key.startsWith('_')
}

function withoutComments(source) {
  const out = {}
  for (const [key, value] of Object.entries(source || {})) {
    if (!isComment(key)) out[key] = value
  }
  return out
}

export function loadGuardsFrom(url, domain) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(url, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return EMPTY
    throw new Error(`guards.json for ${domain} is not valid JSON: ${error.message}`)
  }
  const decisions = withoutComments(parsed.decisions)
  // 【装载时就校验每张表】否则一张缺兜底行的表要等到某个未覆盖的输入
  // 走到它才炸，而那时已经在通话中了。
  for (const [name, table] of Object.entries(decisions)) {
    validateTable(table, `${domain}.${name}`)
  }
  return Object.freeze({
    version: parsed.version || 1,
    domain: parsed.domain || domain,
    preconditions: Object.freeze(withoutComments(parsed.preconditions)),
    decisions: Object.freeze(decisions),
    enums: Object.freeze(withoutComments(parsed.enums)),
    thresholds: Object.freeze(withoutComments(parsed.thresholds)),
  })
}

export function loadGuards(domain) {
  const url = GUARD_FILES[domain]
  return url ? loadGuardsFrom(url, domain) : EMPTY
}

// 兼容旧调用。loadGuards 已改成每次读文件，所以这里不需要做事。
export function clearGuardCache() {}

// 会话里已经成立的事实。preconditions 里的 requires 就是从这些名字里取。
// 【名字要稳定】它们出现在 guards.json 里，改名等于让所有已有配置失效。
export function sessionFacts(session) {
  return {
    identity_verified: Boolean(session.identity?.verified),
    transferred: Boolean(session.transferred),
  }
}

export function checkPreconditions(guards, tool, session) {
  const rule = guards.preconditions?.[tool]
  // 没声明 = 不拦。见文件头那段说明。
  if (!rule) return { ok: true }
  const facts = sessionFacts(session)
  const missing = (rule.requires || []).filter(fact => !facts[fact])
  if (!missing.length) return { ok: true }
  return {
    ok: false,
    missing,
    // onMissing 目前只有 refuse 一种。留这个字段是因为「记警告但放行」
    // 是个真实可能的选项 —— 只读工具在某些场景下也许允许先查后核。
    action: rule.onMissing || 'refuse',
    message: rule.message || `需要先满足 ${missing.join('、')} 才能执行 ${tool}。`,
    policyLine: rule.policyLine ?? null,
  }
}

export function decide(guards, name, inputs) {
  const table = guards.decisions?.[name]
  if (!table) {
    // 决策表缺失时不能默默放行 —— 那等于把「资格判定」这一步删掉。
    // 返回 unavailable 让调用方明确处理（通常是转人工）。
    return { available: false, outcome: null, reason: `没有配置 ${name} 决策表` }
  }
  const result = evaluate(table, inputs, `${guards.domain}.${name}`)
  return {
    available: true,
    outcome: result.outcome,
    reason: result.reason,
    rule: result.rule,
    viaCatchAll: result.viaCatchAll,
    policyLine: table.policyLine ?? null,
  }
}

export function enumValues(guards, name) {
  const values = guards.enums?.[name]
  return Array.isArray(values) ? values : null
}

// 单值阈值（行李费、保险费、免费退窗口）不值得各开一张决策表。
// 拉不到时返回 fallback 而不是抛错：缺一个费率不应该让整通电话停掉。
export function threshold(guards, name, fallback = null) {
  const value = guards.thresholds?.[name]
  return typeof value === 'number' ? value : fallback
}
