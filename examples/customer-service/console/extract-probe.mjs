// 抽取期的数据探查。给 console/extract.mjs 用，不给运行时用。
//
// 【为什么抽取需要看数据库】
// 抽取原本是盲的：模型只看 policy 原文，不知道库里有什么。于是它会抽出
// 落不了地的规则 —— 「家具类 30 天可退」而库里没有家具商品，
// 「refunding 状态可取消」而库里没有这个状态。
//
// 这些缺口现在靠 console/coverage.mjs 事后检出来，但那是【另一个列表】：
// 管理员看到「待决定 15 条」和「覆盖度 3 处缺口」两份东西，得自己对应。
//
// 【摘要与工具的分界】
// 可探查的东西分两类：
//
//   取值域（库里 category / status / cabin 有哪些值）
//     —— 全集很小，四个字段加起来不到二十个值。直接摘要塞进 prompt。
//        为这个做工具是过度设计：模型要多一轮往返才拿到本来能一次给它的东西。
//
//   样本分布（某类别有几笔订单落在 30 天两侧）
//     —— 组合爆炸：类别 × 阈值 × 比较方向。不能全列，只能按需查。
//        这一类才需要工具。
//
// 所以这个模块导出两样东西：summarize() 给摘要版，TOOLS + runTool() 给工具版。
// 哪一版够用由对照实验决定，不靠猜。

const FIELD_SOURCES = Object.freeze({
  // 字段名 → 去哪些集合里找
  category: ['products'],
  status: ['orders', 'reservations'],
  cabin: ['reservations'],
  memberTier: ['users'],
})

function valuesOf(db, field) {
  const found = new Set()
  for (const collection of FIELD_SOURCES[field] || []) {
    for (const row of db[collection] || []) {
      const value = row?.[field]
      if (value !== undefined && value !== null && value !== '') found.add(String(value))
    }
  }
  return [...found].sort()
}

// 「库里有没有家具商品」和「有没有客户买过家具」是两件事 ——
// 后者才是能演示的。所以类别要看订单行里实际出现过的。
function purchasedCategories(db) {
  const found = new Set()
  for (const order of db.orders || []) {
    for (const line of order.items || []) {
      const product = (db.products || []).find(item => item.productId === line.productId)
      if (product?.category) found.add(product.category)
    }
  }
  return [...found].sort()
}

// 某个类别下已签收订单的签收天数。判定「时限规则的边界两侧有没有样本」要用它。
function deliveredDays(db, category) {
  const now = Date.now()
  const days = []
  for (const order of db.orders || []) {
    if (!order.deliveredAt) continue
    const matched = (order.items || []).some(line => {
      const product = (db.products || []).find(item => item.productId === line.productId)
      return product?.category === category
    })
    if (matched) days.push(Math.floor((now - new Date(order.deliveredAt).getTime()) / 86_400_000))
  }
  return days.sort((a, b) => a - b)
}

// ── 摘要版：一次性塞进 prompt ──

export function summarize(db) {
  const lines = []
  for (const field of Object.keys(FIELD_SOURCES)) {
    const values = valuesOf(db, field)
    if (values.length) lines.push(`${field}: ${values.join('、')}`)
  }
  const purchased = purchasedCategories(db)
  if (purchased.length) {
    // 【这一行单独列】它和 category 的差别正是「能不能演示」的差别。
    lines.push(`有客户买过的 category: ${purchased.join('、')}`)
  }
  if (!lines.length) return ''
  return `数据库里实际存在的取值（抽规则时对照这份，写了库里没有的值就在 gaps 里说明）：\n${
    lines.map(line => `- ${line}`).join('\n')}`
}

// ── 工具版：多轮探查 ──

export const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_data_values',
      description: '查数据库里某个字段实际出现过的取值。抽出一条按类别或状态分档的规则之后，'
        + '用它确认那个值在库里存不存在 —— 不存在的规则演示不出来，要写进 gaps。',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: Object.keys(FIELD_SOURCES),
            description: '字段名。category 是商品类别，status 是订单或预订状态，'
              + 'cabin 是舱位，memberTier 是会员等级。',
          },
        },
        required: ['field'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_samples',
      description: '查某个商品类别下已签收订单的签收天数分布。抽出「某类别 N 天内可退」'
        + '这样的规则之后，用它确认库里有没有落在 N 天两侧的样本 —— '
        + '样本全在期限内的话「超期拒退」这一半就演示不出来。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '商品类别，先用 list_data_values 确认它存在。' },
        },
        required: ['category'],
      },
    },
  },
])

export function runTool(db, name, args = {}) {
  if (name === 'list_data_values') {
    const field = String(args.field || '')
    if (!FIELD_SOURCES[field]) {
      return { error: `不认识的字段 ${field}，可查的是 ${Object.keys(FIELD_SOURCES).join(' / ')}` }
    }
    const values = valuesOf(db, field)
    const result = { field, values }
    if (field === 'category') result.purchased = purchasedCategories(db)
    return result
  }
  if (name === 'count_samples') {
    const category = String(args.category || '')
    const days = deliveredDays(db, category)
    return {
      category,
      deliveredDays: days,
      // 【把结论也给出来】只给一串天数的话，模型要自己比较，
      // 而它算错了我们看不出来。这里直接说清分布。
      note: days.length
        ? `这个类别有 ${days.length} 笔已签收订单，签收天数：${days.join('、')}`
        : `库里没有 ${category} 类别的已签收订单`,
    }
  }
  return { error: `不认识的工具 ${name}` }
}
