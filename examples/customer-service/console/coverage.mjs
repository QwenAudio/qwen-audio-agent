// 覆盖度检查：新传的 policy 抽出来的规则，现有数据库能不能演示得出来。
//
// 【为什么需要这一步 —— 卡点二的正确解法】
// 用户原本的想法是「重传 policy 之后要能编辑数据库」，因果是对的：
// 新 policy 提到「家具类 30 天可退」，而库里没有家具类商品，那条规则
// 就永远走不到，管理员改完看不出效果。
//
// 但解法不该是给数据库开 CRUD —— 那要求管理员知道 orders.items[].productId
// 得指向真实的 products，改错一处整套演示就哑掉。
// 真正需要的是【告诉他缺什么】：缺哪个类别、缺哪个状态、缺哪个枚举值。
// 知道缺什么之后，再决定是补数据还是改 policy。
//
// 检查的三类东西：
//   一、决策表的输入值域    表里出现的每个值，库里有没有对应的数据
//
// 【顶层键叫 decisions 不叫 tables】我第一版凭记忆写成 guards.tables，
// 于是整个检查一行都没跑到 —— 两个域都返回「全部覆盖」。
// 那个「全绿」看起来像好消息，实际是检查压根没工作。
// 反证的时候脚本自己抛 TypeError 才暴露出来。
//   二、枚举               enums 里的值，库里用到没有
//   三、区间边界           时限类规则，库里有没有落在边界两侧的样本

const CATEGORY_FIELDS = Object.freeze(['category', 'status', 'cabin', 'memberTier'])

// 从库里收集某个字段实际出现过的值。
// 【要跨多个集合找】category 在 products 上，status 在 orders 上，
// cabin 在 reservations 上，memberTier 在 users 上 —— 不能只看一个表。
function observedValues(db, field) {
  const found = new Set()
  const visit = rows => {
    for (const row of rows || []) {
      if (row && row[field] !== undefined && row[field] !== null) {
        found.add(String(row[field]))
      }
    }
  }
  visit(db.products)
  visit(db.orders)
  visit(db.reservations)
  visit(db.users)
  visit(db.flights)
  // 订单行里的商品要回表查类别 —— 「库里有没有家具类商品」不等于
  // 「有没有客户买过家具」。后者才是能演示的。
  for (const order of db.orders || []) {
    for (const line of order.items || []) {
      const product = (db.products || []).find(item => item.productId === line.productId)
      if (product && product[field] !== undefined) found.add(String(product[field]))
    }
  }
  return found
}

// 决策表的一行里，某个输入列写了哪个具体值。
// 只认字面量 —— 比较式（> 3000）和区间（]2..4]）另外处理。
function literalOf(condition) {
  if (condition === undefined || condition === null) return null
  const text = String(condition).trim()
  if (!text || text === '-' || text === '*') return null
  if (/^[<>=!]/.test(text) || /\.\./.test(text)) return null
  return text
}

function checkTables(guards, db) {
  const gaps = []
  for (const [tableName, table] of Object.entries(guards.decisions || {})) {
    if (tableName.startsWith('_')) continue
    for (const [index, rule] of (table.rules || []).entries()) {
      for (const [field, condition] of Object.entries(rule.when || {})) {
        const literal = literalOf(condition)
        if (!literal) continue
        // 布尔类的输入（hasFlownSegment: 'true'）不查库 ——
        // 它们是算出来的，不是库里的字段。
        if (literal === 'true' || literal === 'false') continue
        if (!CATEGORY_FIELDS.includes(field)) continue
        if (!observedValues(db, field).has(literal)) {
          gaps.push({
            kind: 'table_value',
            table: tableName,
            ruleIndex: index,
            field,
            value: literal,
            detail: `决策表 ${tableName} 第 ${index + 1} 行按 ${field}=${literal} 判定，`
              + `但数据库里没有任何 ${field} 是 ${literal} 的记录 —— 这条规则演示不出来`,
            fix: `往库里加一条 ${field}=${literal} 的记录，或者确认 policy 里真有这一类`,
          })
        }
      }
    }
  }
  return gaps
}

function checkEnums(guards, db) {
  const gaps = []
  for (const [enumName, values] of Object.entries(guards.enums || {})) {
    if (enumName.startsWith('_')) continue
    if (!Array.isArray(values)) continue
    // 枚举名到库字段的映射：cabin → cabin，member_tier → memberTier。
    const field = enumName === 'member_tier' ? 'memberTier' : enumName
    if (!CATEGORY_FIELDS.includes(field)) continue
    const observed = observedValues(db, field)
    for (const value of values) {
      if (!observed.has(String(value))) {
        gaps.push({
          kind: 'enum_value',
          enum: enumName,
          value,
          detail: `枚举 ${enumName} 允许 ${value}，但库里没有用到 —— `
            + '客户不可能提出这种情形，这个取值走不到',
          fix: `加一条 ${field}=${value} 的记录`,
        })
      }
    }
  }
  return gaps
}

// 时限类规则的边界样本：库里要有落在边界两侧的数据，
// 否则「30 天内可退 / 超过不可退」这条只能演示一半。
function checkBoundaries(guards, db) {
  const gaps = []
  const table = guards.decisions?.return_window
  if (!table) return gaps

  const now = Date.now()
  const daysSince = iso => (iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : null)

  for (const [index, rule] of (table.rules || []).entries()) {
    const category = literalOf(rule.when?.category)
    if (!category) continue
    const limit = Number(rule.then)
    if (!Number.isFinite(limit) || limit <= 0) continue

    // 找这个类别下的已签收订单，看签收天数分布在边界哪一侧。
    const samples = []
    for (const order of db.orders || []) {
      if (!order.deliveredAt) continue
      for (const line of order.items || []) {
        const product = (db.products || []).find(item => item.productId === line.productId)
        if (product?.category === category) samples.push(daysSince(order.deliveredAt))
      }
    }
    if (!samples.length) continue
    const within = samples.some(days => days <= limit)
    const beyond = samples.some(days => days > limit)
    if (!within || !beyond) {
      gaps.push({
        kind: 'boundary',
        table: 'return_window',
        ruleIndex: index,
        field: 'category',
        value: category,
        detail: `${category} 的退货时限是 ${limit} 天，但库里的样本`
          + (within ? '全部在期限内' : '全部已超期')
          + `（签收天数：${samples.sort((a, b) => a - b).join('、')}）`
          + ` —— 只能演示${within ? '可退' : '拒退'}这一半`,
        fix: within
          ? `加一笔 ${category} 类、签收超过 ${limit} 天的订单`
          : `加一笔 ${category} 类、签收在 ${limit} 天内的订单`,
      })
    }
  }
  return gaps
}

export function checkCoverage(guards, db) {
  if (!guards || !db) {
    throw new TypeError('覆盖度检查需要 guards 与 db 两份数据')
  }
  const gaps = [
    ...checkTables(guards, db),
    ...checkEnums(guards, db),
    ...checkBoundaries(guards, db),
  ]
  // 同一个 field=value 可能被多张表引用，去重之后按类型排 ——
  // 管理员关心的是「缺哪几样东西」，不是「哪几行提到它」。
  const seen = new Map()
  for (const gap of gaps) {
    const key = `${gap.kind}:${gap.field || gap.enum}:${gap.value}`
    if (!seen.has(key)) {
      seen.set(key, { ...gap, sources: [] })
    }
    if (gap.table) seen.get(key).sources.push(`${gap.table} 第 ${gap.ruleIndex + 1} 行`)
  }
  const unique = [...seen.values()]
  return {
    ok: unique.length === 0,
    gaps: unique,
    summary: unique.length === 0
      ? '现有数据能覆盖所有规则，每一条都演示得出来。'
      : `有 ${unique.length} 处规则演示不出来，需要补数据或确认 policy。`,
  }
}
