import { validateTable } from '../service/decision-table.mjs'
import { allToolNames } from '../service/tools/registry.mjs'

export const REVIEW_STATUS = Object.freeze([
  'accepted', 'rejected', 'policy_gap', 'data_gap',
])

export function frontendConfigName(domain) {
  return domain === 'airline' ? 'frontend-mcp.airline.json' : 'frontend-mcp.json'
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function issue(errors, path, message) {
  errors.push({ path, message })
}

function uncommentedEntries(value) {
  return Object.entries(value || {}).filter(([key]) => !key.startsWith('_'))
}

export function validateGuardsDocument(domain, guards) {
  const errors = []
  if (!isObject(guards)) return { ok: false, errors: [{ path: 'guards', message: '必须是对象' }] }
  if (guards.domain !== domain) issue(errors, 'guards.domain', `必须等于当前域 ${domain}`)
  if (!isObject(guards.decisions)) issue(errors, 'guards.decisions', '必须是对象')
  if (!isObject(guards.preconditions)) issue(errors, 'guards.preconditions', '必须是对象')
  if (!isObject(guards.enums)) issue(errors, 'guards.enums', '必须是对象')
  if (guards.thresholds !== undefined && !isObject(guards.thresholds)) {
    issue(errors, 'guards.thresholds', '必须是对象')
  }

  for (const [name, table] of uncommentedEntries(guards.decisions)) {
    try {
      validateTable(table, `${domain}.${name}`)
    } catch (error) {
      issue(errors, `guards.decisions.${name}`, error.message)
      continue
    }
    if (!Array.isArray(table.inputs) || table.inputs.some(input => typeof input !== 'string' || !input)) {
      issue(errors, `guards.decisions.${name}.inputs`, '必须是非空字段名数组')
    }
    for (const [index, rule] of (table.rules || []).entries()) {
      if (!isObject(rule.when)) {
        issue(errors, `guards.decisions.${name}.rules[${index}].when`, '必须是条件对象')
      }
    }
  }

  const knownTools = new Set(allToolNames(domain))
  for (const [tool, rule] of uncommentedEntries(guards.preconditions)) {
    if (!knownTools.has(tool)) {
      issue(errors, `guards.preconditions.${tool}`, `当前域没有工具 ${tool}`)
    }
    if (!isObject(rule) || !Array.isArray(rule.requires) || !rule.requires.length) {
      issue(errors, `guards.preconditions.${tool}.requires`, '至少声明一个会话事实')
    }
    if (rule?.onMissing && !['refuse', 'warn'].includes(rule.onMissing)) {
      issue(errors, `guards.preconditions.${tool}.onMissing`, '只支持 refuse 或 warn')
    }
  }

  for (const [name, values] of uncommentedEntries(guards.enums)) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
      issue(errors, `guards.enums.${name}`, '必须是字符串数组')
    } else if (new Set(values).size !== values.length) {
      issue(errors, `guards.enums.${name}`, '不能包含重复值')
    }
  }
  for (const [name, value] of uncommentedEntries(guards.thresholds)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issue(errors, `guards.thresholds.${name}`, '必须是有限数字')
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validateFlowsDocument(domain, flows) {
  const errors = []
  if (!isObject(flows)) return { ok: false, errors: [{ path: 'flows', message: '必须是对象' }] }
  if (flows.domain !== domain) issue(errors, 'flows.domain', `必须等于当前域 ${domain}`)
  if (!Array.isArray(flows.rules)) {
    issue(errors, 'flows.rules', '必须是数组')
    return { ok: false, errors }
  }
  const ids = new Set()
  for (const [index, rule] of flows.rules.entries()) {
    const path = `flows.rules[${index}]`
    if (!isObject(rule)) {
      issue(errors, path, '必须是对象')
      continue
    }
    if (typeof rule.id !== 'string' || !rule.id.trim()) issue(errors, `${path}.id`, '不能为空')
    else if (ids.has(rule.id)) issue(errors, `${path}.id`, `重复 id：${rule.id}`)
    else ids.add(rule.id)
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
      issue(errors, `${path}.enabled`, '必须是布尔值')
    }
    if (typeof rule.before !== 'string' || !rule.before.trim()) issue(errors, `${path}.before`, '不能为空')
    if (typeof rule.after !== 'string' || !rule.after.trim()) issue(errors, `${path}.after`, '不能为空')
    if (String(rule.before || '').trim() === String(rule.after || '').trim()) {
      issue(errors, path, '前置动作和后续动作不能相同')
    }
    if (rule.policyLine !== undefined
      && (!Number.isInteger(rule.policyLine) || rule.policyLine < 1)) {
      issue(errors, `${path}.policyLine`, '必须是正整数')
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validateReviewDocument(domain, review) {
  const errors = []
  if (!isObject(review)) return { ok: false, errors: [{ path: 'review', message: '必须是对象' }] }
  if (review.domain !== domain) issue(errors, 'review.domain', `必须等于当前域 ${domain}`)
  if (!isObject(review.items)) {
    issue(errors, 'review.items', '必须是对象')
    return { ok: false, errors }
  }
  for (const [key, entry] of Object.entries(review.items)) {
    if (!isObject(entry)) {
      issue(errors, `review.items.${key}`, '必须是对象')
      continue
    }
    if (!REVIEW_STATUS.includes(entry.status)) {
      issue(errors, `review.items.${key}.status`, `只支持 ${REVIEW_STATUS.join(' / ')}`)
    }
    if (!isObject(entry.item)) issue(errors, `review.items.${key}.item`, '必须保留管理员裁决时看到的候选项')
  }
  return { ok: errors.length === 0, errors }
}

export function validateFrontendMcpDocument(domain, frontendMcp) {
  const errors = []
  if (!isObject(frontendMcp)) {
    return { ok: false, errors: [{ path: 'frontendMcp', message: '必须是对象' }] }
  }
  const server = frontendMcp.servers?.['customer-service']
  if (!isObject(server)) issue(errors, 'frontendMcp.servers.customer-service', '缺少客服 MCP server')
  const tools = server?.tools
  if (!isObject(tools)) issue(errors, 'frontendMcp.servers.customer-service.tools', '必须是对象')
  const known = new Set(allToolNames(domain))
  for (const [name, config] of Object.entries(tools || {})) {
    if (!known.has(name)) issue(errors, `frontendMcp.tools.${name}`, `当前域没有工具 ${name}`)
    if (!isObject(config) || config.enabled !== true) {
      issue(errors, `frontendMcp.tools.${name}`, '前台名单中的工具必须 enabled=true')
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validateConfiguration(domain, configuration) {
  const parts = [
    validateGuardsDocument(domain, configuration?.guards),
    validateFlowsDocument(domain, configuration?.flows),
    validateReviewDocument(domain, configuration?.review),
    validateFrontendMcpDocument(domain, configuration?.frontendMcp),
  ]
  const errors = parts.flatMap(part => part.errors)
  return { ok: errors.length === 0, errors }
}

function scalar(value) {
  if (value === undefined) return '（不存在）'
  if (isObject(value) || Array.isArray(value)) return JSON.stringify(value)
  return String(value)
}

export function diffDocuments(before, after, prefix = '', output = []) {
  if (Object.is(before, after)) return output
  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      output.push({ path: prefix || 'root', before: scalar(before), after: scalar(after) })
    }
    return output
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of [...keys].sort()) {
      diffDocuments(before[key], after[key], prefix ? `${prefix}.${key}` : key, output)
    }
    return output
  }
  output.push({ path: prefix || 'root', before: scalar(before), after: scalar(after) })
  return output
}

export function configurationDiff(current, proposed) {
  return {
    guards: diffDocuments(current.guards, proposed.guards),
    flows: diffDocuments(current.flows, proposed.flows),
    review: diffDocuments(current.review, proposed.review),
    frontendMcp: diffDocuments(current.frontendMcp, proposed.frontendMcp),
  }
}

// —— 写回时的序列化 ——
//
// 【不能用 JSON.stringify(value, null, 2)】它把每个数组、每个对象都摊开成多行。
// 实测：配置台改一条规则的一个值，guards.json 产生 454 行 diff ——
// 一份手写成「一条规则一行」的表被炸成一行一个花括号。
//
// 这不是好不好看的问题。这些文件的立足点就是「人能读、能审、能手改」，
// 旁边那些 _note 注释都是为人写的。一改动就产生几百行噪声，
// 等于把可审性删掉：谁也没法在 code review 里看出实际改了什么。
//
// 于是自己写：短的结构留在一行，长到超出预算才展开。
// 预算按字符数算而不是显示宽度 —— 这些文件里中文很多，
// 严格算宽度要引入字符宽度表，而字符数已经够把行长压在可读范围内。
const INLINE_BUDGET = 100

function oneLine(value) {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(', ')}]`
  if (isObject(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${oneLine(item)}`).join(', ')} }`
  }
  return JSON.stringify(value)
}

function render(value, indent) {
  // 【基本类型必须先返回，不能等预算判断】一条长字符串是没法「展开」的，
  // 而下面的展开分支会对它调 Object.entries —— 那会把字符串拆成
  // {"0":"由","1":"c",…} 这样的字符对象，静默损坏配置文件。
  // retail 的 _note 有 131 字符，正好越过预算，实测就是这么炸的。
  if (!Array.isArray(value) && !isObject(value)) return oneLine(value)
  const compact = oneLine(value)
  if (indent.length + compact.length <= INLINE_BUDGET) return compact
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    const items = value.map(item => `${inner}${render(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  const items = Object.entries(value)
    .map(([key, item]) => `${inner}${JSON.stringify(key)}: ${render(item, inner)}`)
  return `{\n${items.join(',\n')}\n${indent}}`
}

export function formatJson(value) {
  return `${render(value, '')}\n`
}
