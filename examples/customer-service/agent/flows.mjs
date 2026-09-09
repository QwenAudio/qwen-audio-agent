import { readFileSync } from 'node:fs'

const FLOW_FILES = Object.freeze({
  retail: new URL('../domains/retail/flows.json', import.meta.url),
  airline: new URL('../domains/airline/flows.json', import.meta.url),
})

export function loadFlowsFrom(path, domain) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      version: parsed.version || 1,
      domain: parsed.domain || domain,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, domain, rules: [] }
    throw new Error(`flows.json for ${domain} is not valid JSON: ${error.message}`)
  }
}

export function loadFlows(domain) {
  const path = FLOW_FILES[domain]
  return path ? loadFlowsFrom(path, domain) : { version: 1, domain, rules: [] }
}

export function formatFlowPrompt(flows) {
  const active = flows.rules.filter(rule => rule.enabled !== false)
  if (!active.length) return ''
  const lines = active.map((rule, index) => {
    const order = `先「${rule.before}」，再「${rule.after}」`
    const detail = rule.instruction ? `；${rule.instruction}` : ''
    return `${index + 1}. ${order}${detail}`
  })
  return `\n\n管理员配置的流程约束：\n${lines.join('\n')}\n这些约束用于安排步骤顺序；资格、金额与最终结果仍以工具返回为准。`
}

// 每次创建后台任务时重新读。配置台应用后不需要重启 Agent；
// 正在执行的任务保留启动时的 prompt，下一笔任务使用新流程。
export function flowPrompt(domain) {
  return formatFlowPrompt(loadFlows(domain))
}
