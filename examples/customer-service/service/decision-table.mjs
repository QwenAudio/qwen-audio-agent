// 决策表求值器。schema 借 DMN（Decision Model and Notation）的形态：
// 输入列 + 规则行 + Hit policy + 兜底行。
//
// 【为什么用决策表而不是把逻辑写在代码或 prompt 里】
// arXiv 2505.11701（DMN-Guided Prompting）指出的问题正是我们的问题：
//   "Since decision logic is typically embedded in prompts, it becomes
//    challenging for end users to modify or refine it."
// 管理员改不了 prompt 里的逻辑，也改不了 executor 里的 if。表格他能改。
//
// 【只实现 FEEL 的一个最小子集】完整 FEEL 是一门表达式语言，这里只要
// 比较、区间、字面量、通配四种。多出来的表达能力换不到东西，
// 却会让「管理员能看懂这张表」这个前提失效。

// Hit policy 决定多行同时命中时怎么办。DMN 定义了更多种，这里只要三种。
export const HIT_POLICY = Object.freeze({
  // 自上而下，第一条命中即返回。规则可以重叠，靠顺序消歧。
  FIRST: 'first',
  // 规则不许重叠。命中多于一条说明表写错了，直接报错而不是随便挑一条 ——
  // 「退货窗口既是 30 天又是 7 天」这种冲突必须暴露出来。
  UNIQUE: 'unique',
  // 收集所有命中行。用于「同时触发多个转人工条件」这类场景。
  COLLECT: 'collect',
})

const COMPARATORS = Object.freeze([
  ['<=', (left, right) => left <= right],
  ['>=', (left, right) => left >= right],
  ['<', (left, right) => left < right],
  ['>', (left, right) => left > right],
  ['==', (left, right) => left === right],
  ['!=', (left, right) => left !== right],
])

// DMN 的区间记法：[a..b] 闭区间，]a..b[ 开区间，可以混用。
// 「7 天内」和「超过 7 天」的边界差一天就是两种业务结果，
// 所以开闭必须能精确表达，不能一律当闭区间。
const RANGE = /^([[\]])\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*([[\]])$/

export class DecisionTableError extends Error {
  constructor(message, { table, rule } = {}) {
    super(message)
    this.name = 'DecisionTableError'
    this.table = table
    this.rule = rule
  }
}

// 通配的判定要独立成函数，不能靠「拿一个不可能匹配的值去试」来反推。
// 第一版用 Symbol 当探针，结果 Number(Symbol) 直接抛 TypeError ——
// 而那个抛错发生在 isCatchAll 里，把整张表的求值都带崩了。
function isWildcard(condition) {
  if (condition === undefined || condition === null) return true
  const text = String(condition).trim()
  return !text || text === '-' || text === '*'
}

function matchesCondition(condition, value) {
  // 通配：字段缺省、写成 '-' 或空串，都表示「任意值」。
  // 兜底行就是所有列都通配的那一行。
  if (isWildcard(condition)) return true
  const text = String(condition).trim()

  const range = text.match(RANGE)
  if (range) {
    const [, open, low, high, close] = range
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return false
    const lowOk = open === '[' ? numeric >= Number(low) : numeric > Number(low)
    const highOk = close === ']' ? numeric <= Number(high) : numeric < Number(high)
    return lowOk && highOk
  }

  for (const [token, compare] of COMPARATORS) {
    if (!text.startsWith(token)) continue
    const operand = text.slice(token.length).trim()
    const right = Number(operand)
    // 比较运算符后面跟非数字时按字符串比 —— '== apparel' 也要能用。
    if (!Number.isFinite(right)) return compare(String(value), operand)
    const left = Number(value)
    return Number.isFinite(left) ? compare(left, right) : false
  }

  // 没有运算符：字面量相等。数字与数字串（30 与 "30"）视为相等，
  // 因为 JSON 配置里管理员两种都可能写。
  if (typeof value === 'number' && String(value) === text) return true
  return String(value) === text
}

function matchesRule(rule, inputs) {
  const when = rule.when || {}
  return Object.keys(when).every(key => matchesCondition(when[key], inputs[key]))
}

// 兜底行 = when 为空或所有条件都是通配。
// 它必须存在：没有兜底行时，一个没被任何规则覆盖的输入会返回 undefined，
// 而调用方多半会把 undefined 当成「没限制」放行 —— 那正好是最危险的默认。
function isCatchAll(rule) {
  const when = rule.when || {}
  const keys = Object.keys(when)
  if (!keys.length) return true
  return keys.every(key => isWildcard(when[key]))
}

export function validateTable(table, name = 'table') {
  if (!table || typeof table !== 'object') {
    throw new DecisionTableError(`Decision table ${name} is missing`, { table: name })
  }
  if (!Array.isArray(table.rules) || !table.rules.length) {
    throw new DecisionTableError(`Decision table ${name} has no rules`, { table: name })
  }
  const policy = table.hitPolicy || HIT_POLICY.FIRST
  if (!Object.values(HIT_POLICY).includes(policy)) {
    throw new DecisionTableError(
      `Decision table ${name} has unknown hit policy: ${policy}`, { table: name },
    )
  }
  for (const [index, rule] of table.rules.entries()) {
    if (rule.then === undefined) {
      throw new DecisionTableError(
        `Decision table ${name} rule ${index + 1} has no outcome`, { table: name, rule: index + 1 },
      )
    }
  }
  // collect 策略下没有「唯一结果」的概念，兜底行没有意义。
  if (policy !== HIT_POLICY.COLLECT && !table.rules.some(isCatchAll)) {
    throw new DecisionTableError(
      `Decision table ${name} has no catch-all rule; an uncovered input would silently return nothing`,
      { table: name },
    )
  }
  return true
}

export function evaluate(table, inputs = {}, name = 'table') {
  validateTable(table, name)
  const policy = table.hitPolicy || HIT_POLICY.FIRST
  const hits = table.rules
    .map((rule, index) => ({ rule, index }))
    .filter(entry => matchesRule(entry.rule, inputs))

  if (policy === HIT_POLICY.COLLECT) {
    return {
      matched: hits.length > 0,
      outcomes: hits.map(entry => entry.rule.then),
      rules: hits.map(entry => entry.index + 1),
      reasons: hits.map(entry => entry.rule.reason).filter(Boolean),
    }
  }

  if (policy === HIT_POLICY.UNIQUE) {
    // 排掉兜底行再数：兜底行本来就和别的行重叠，那不算冲突。
    const specific = hits.filter(entry => !isCatchAll(entry.rule))
    if (specific.length > 1) {
      throw new DecisionTableError(
        `Decision table ${name} is declared unique but rules `
        + `${specific.map(entry => entry.index + 1).join(', ')} all match`,
        { table: name },
      )
    }
  }

  const chosen = hits[0]
  if (!chosen) return { matched: false, outcome: undefined, rule: null, reason: null }
  return {
    matched: true,
    outcome: chosen.rule.then,
    rule: chosen.index + 1,
    reason: chosen.rule.reason || null,
    // 命中兜底行要能被调用方识别 —— 「按兜底放行」和「按具体规则放行」
    // 在审计上是两回事。
    viaCatchAll: isCatchAll(chosen.rule),
  }
}
