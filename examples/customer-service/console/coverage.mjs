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
//   二、枚举               enums 里的值，库里用到没有
//   三、区间边界           时限类规则，库里有没有落在边界两侧的样本
//
// 【顶层键叫 decisions 不叫 tables】我第一版凭记忆写成 guards.tables，
// 于是整个检查一行都没跑到 —— 两个域都返回「全部覆盖」。
// 那个「全绿」看起来像好消息，实际是检查压根没工作。
// 反证的时候脚本自己抛 TypeError 才暴露出来。
// console/test/coverage.test.mjs 里有一条测试守着这个结构假设。

import { matchesCondition } from '../service/decision-table.mjs'

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

// 【样本从哪来 —— 决策表的输入字段到库里的取数方式】
//
// 第一版只硬编码了 return_window 一张表，于是航空的 refundable、
// delay_compensation、change_fee 全都没检 —— 而「出票 24 小时内可免费退」
// 这条实测库里【零笔样本】，检查却报「全部覆盖」。
//
// 泛化的判据换了：不再是「边界两侧有没有样本」，而是
// 【这一行有没有任何样本能命中】。后者更强也更简单：
// 一张表的每一行都该有数据能走到，走不到的那一行就是演示不出来的。
const SAMPLE_SOURCES = Object.freeze({
  // 订单签收天数 —— 退货时限那张表的输入。按类别分组，
  // 因为 return_window 是「类别 + 天数」两个输入。
  daysSinceDelivery: (db) => {
    const now = Date.now()
    const rows = []
    for (const order of db.orders || []) {
      if (!order.deliveredAt) continue
      const days = Math.floor((now - new Date(order.deliveredAt).getTime()) / 86_400_000)
      for (const line of order.items || []) {
        const product = (db.products || []).find(item => item.productId === line.productId)
        rows.push({ daysSinceDelivery: days, category: product?.category })
      }
    }
    return rows
  },

  // 出票至今多少小时 —— refundable 表的 hoursSinceBooking。
  hoursSinceBooking: (db) => {
    const now = Date.now()
    return (db.reservations || []).map(reservation => ({
      hoursSinceBooking: (now - new Date(reservation.bookedAt).getTime()) / 3_600_000,
      cabin: reservation.cabin,
      hasInsurance: String(Boolean(reservation.insurance)),
    }))
  },

  // 航班延误时长 —— delay_compensation 表的输入。
  // 【只取延误的航班】正常航班的 delayHours 是 undefined，
  // 拿它去匹配 '> 8' 会因为 Number(undefined) 得 NaN 而永远不命中，
  // 于是每一行都报「没有样本」—— 假警报。
  delayHours: (db) => (db.flights || [])
    .filter(flight => flight.status === 'delayed')
    .map(flight => ({ delayHours: flight.delayHours || 0 })),

  // 金额 —— refund_authority 表的输入。订单和预订都算。
  amount: (db) => [
    ...(db.orders || []).map(order => ({ amount: order.total })),
    ...(db.reservations || []).map(reservation => ({ amount: reservation.total })),
  ],
})

// 这一行里有哪些字段是「能从库里取到样本」的。
// 【一行可能混着能取和不能取的字段】refundable 那张表既有 hoursSinceBooking
// （能取），也有 hasFlownSegment（算出来的，不是库里字段）。
// 只要有一个能取的字段，这一行就值得检 —— 拿那个字段的样本去试整行。
function sampleFieldsOf(rule) {
  return Object.keys(rule.when || {}).filter(field => SAMPLE_SOURCES[field])
}

// 库里有没有样本能命中这一行。
// 用 decision-table 的 matchesCondition —— 必须是同一套逻辑，
// 各写一份的话区间开闭这些细节早晚分岔。
function anySampleHits(rule, samples) {
  return samples.some(sample => Object.entries(rule.when || {}).every(([field, condition]) => {
    // 样本里没有这个字段就跳过 —— 那是算出来的输入（hasFlownSegment 之类），
    // 不参与「有没有数据」的判断。
    if (!(field in sample)) return true
    return matchesCondition(condition, sample[field])
  }))
}

function checkBoundaries(guards, db) {
  const gaps = []
  for (const [tableName, table] of Object.entries(guards.decisions || {})) {
    if (tableName.startsWith('_')) continue
    const rules = table.rules || []
    for (const [index, rule] of rules.entries()) {
      // 兜底行不检 —— 它就是为了「什么都没命中」而存在的。
      if (!Object.keys(rule.when || {}).length) continue

      const fields = sampleFieldsOf(rule)
      if (!fields.length) continue

      // 多个可取字段时合并样本：取第一个字段的样本集，
      // 它里面已经带上了同一条记录的其他字段（见 SAMPLE_SOURCES 的返回结构）。
      const samples = SAMPLE_SOURCES[fields[0]](db)
      if (!samples.length) continue

      if (!anySampleHits(rule, samples)) {
        const shown = Object.entries(rule.when)
          .map(([field, condition]) => `${field} ${condition}`)
          .join('、')
        gaps.push({
          kind: 'no_sample',
          table: tableName,
          ruleIndex: index,
          field: fields[0],
          value: shown,
          detail: `决策表 ${tableName} 第 ${index + 1} 行（${shown}）`
            + '在库里找不到任何能命中它的记录 —— 这条规则演示不出来',
          fix: `造一条满足「${shown}」的记录`,
        })
      }
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
