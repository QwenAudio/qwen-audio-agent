// 数据库编辑的校验层。
//
// 【为什么编辑必须带校验 —— 卡点三】
// 库里的引用是自洽的：orders.items[].productId 指向 products，
// orders.userId 指向 users，reservations.segments[].flightNo 指向 flights，
// payment.methodId 指向 users.paymentMethods。
//
// 手工改一处就可能断掉一条链，而断掉之后的表现不是报错，是【工具静默返回空】：
// 客户问「我买的那台冰箱」，get_order 查得到订单但查不到商品名，
// 于是模型说「订单里的商品信息不完整」—— 演示当场废掉，而且很难归因。
//
// service/test/db-integrity.test.mjs 里的 15 条完整性测试守着初始数据。
// 这一层是它的运行时版本：管理员改完立刻知道断了哪一条，改不进去。
//
// 【只做整份替换，不做逐字段 CRUD】
// 逐字段编辑要暴露路径（orders[2].items[0].quantity），而管理员在界面上
// 点错一格就写坏。整份 JSON 提交 + 一次性校验，要么全过要么全退，
// 语义比一堆小接口清楚。

const REQUIRED_COLLECTIONS = Object.freeze({
  retail: ['users', 'products', 'orders'],
  airline: ['users', 'flights', 'reservations'],
})

function fail(errors, path, message, hint) {
  errors.push({ path, message, hint: hint || null })
}

// 主键唯一。重复的主键比缺失更隐蔽 ——
// find() 只会返回第一个，于是「改了订单却看不到变化」。
function checkUnique(rows, key, label, errors) {
  const seen = new Set()
  for (const [index, row] of (rows || []).entries()) {
    const value = row?.[key]
    if (value === undefined || value === null || value === '') {
      fail(errors, `${label}[${index}].${key}`, `缺少主键 ${key}`)
      continue
    }
    if (seen.has(value)) {
      fail(errors, `${label}[${index}].${key}`, `主键重复：${value}`,
        'find() 只会命中第一条，于是改了后面那条却看不到任何变化')
    }
    seen.add(value)
  }
}

function idSet(rows, key) {
  return new Set((rows || []).map(row => row?.[key]).filter(Boolean))
}

function checkRetail(db, errors) {
  const users = idSet(db.users, 'userId')
  const products = idSet(db.products, 'productId')

  checkUnique(db.users, 'userId', 'users', errors)
  checkUnique(db.products, 'productId', 'products', errors)
  checkUnique(db.orders, 'orderId', 'orders', errors)

  for (const [index, order] of (db.orders || []).entries()) {
    const at = `orders[${index}]`
    if (!users.has(order.userId)) {
      fail(errors, `${at}.userId`, `指向不存在的用户 ${order.userId}`,
        'list_orders 会漏掉这笔，而客户明明记得下过单')
    }
    for (const [line, item] of (order.items || []).entries()) {
      if (!products.has(item.productId)) {
        fail(errors, `${at}.items[${line}].productId`,
          `指向不存在的商品 ${item.productId}`,
          'get_order 查得到订单但查不到商品名，模型会说「商品信息不完整」')
      }
    }
    // 支付方式必须是这位用户自己的 —— 退款要往这张卡上打。
    const owner = (db.users || []).find(user => user.userId === order.userId)
    const methods = idSet(owner?.paymentMethods, 'id')
    if (order.payment?.methodId && !methods.has(order.payment.methodId)) {
      fail(errors, `${at}.payment.methodId`,
        `指向的支付方式不在用户 ${order.userId} 名下`,
        '退款话术会说不出到账渠道')
    }
    // 已签收的必须有签收时间 —— 退货时限全靠它算。
    if (order.status === 'delivered' && !order.deliveredAt) {
      fail(errors, `${at}.deliveredAt`, '状态是已签收但没有签收时间',
        '退货时限判定拿不到天数，那条规则会走兜底行')
    }
  }
}

function checkAirline(db, errors) {
  const users = idSet(db.users, 'userId')

  checkUnique(db.users, 'userId', 'users', errors)
  checkUnique(db.reservations, 'reservationId', 'reservations', errors)

  // 航班的主键是「航班号 + 日期」，不是航班号 ——
  // 同一航班号可以有多天。这一点在 get_flight_status 里也处理过。
  const flightKeys = new Set()
  for (const [index, flight] of (db.flights || []).entries()) {
    const key = `${flight?.flightNo}@${flight?.date}`
    if (flightKeys.has(key)) {
      fail(errors, `flights[${index}]`, `航班号加日期重复：${key}`,
        '改签会随机命中其中一班')
    }
    flightKeys.add(key)
    for (const cabin of ['basic_economy', 'economy', 'business']) {
      if (flight?.prices?.[cabin] === undefined) {
        fail(errors, `flights[${index}].prices.${cabin}`, '缺少票价',
          '改签或改舱位算差价时会当成 0，客户少付钱')
      }
      if (flight?.seats?.[cabin] === undefined) {
        fail(errors, `flights[${index}].seats.${cabin}`, '缺少余量',
          '搜航班会把它当成满舱，从改签候选里消失')
      }
    }
  }

  for (const [index, reservation] of (db.reservations || []).entries()) {
    const at = `reservations[${index}]`
    if (!users.has(reservation.userId)) {
      fail(errors, `${at}.userId`, `指向不存在的用户 ${reservation.userId}`,
        'list_reservations 会漏掉这笔')
    }
    if (!(reservation.segments || []).length) {
      fail(errors, `${at}.segments`, '一个航段都没有',
        '预订详情会是空的，改签也无从下手')
    }
    for (const [seg, segment] of (reservation.segments || []).entries()) {
      const key = `${segment?.flightNo}@${segment?.date}`
      if (!flightKeys.has(key)) {
        fail(errors, `${at}.segments[${seg}]`,
          `指向不存在的航班 ${key}`,
          '预订详情会显示「查不到航班信息」，退票与改签的资格判定全部失灵')
      }
    }
    const owner = (db.users || []).find(user => user.userId === reservation.userId)
    const methods = idSet(owner?.paymentMethods, 'id')
    if (reservation.payment?.methodId && !methods.has(reservation.payment.methodId)) {
      fail(errors, `${at}.payment.methodId`,
        `指向的支付方式不在用户 ${reservation.userId} 名下`,
        '退款话术说不出到账渠道')
    }
  }
}

export function validateDatabase(domain, db) {
  const errors = []
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    return { ok: false, errors: [{ path: '', message: '不是一个 JSON 对象', hint: null }] }
  }
  const required = REQUIRED_COLLECTIONS[domain]
  if (!required) {
    return { ok: false, errors: [{ path: '', message: `未知的域：${domain}`, hint: null }] }
  }
  for (const name of required) {
    if (!Array.isArray(db[name])) {
      fail(errors, name, `缺少集合 ${name}，或者它不是数组`)
    }
  }
  // 集合缺了就不往下查了 —— 后面每一条都会连带报错，噪声压过真正的问题。
  if (errors.length) return { ok: false, errors }

  if (domain === 'retail') checkRetail(db, errors)
  else checkAirline(db, errors)

  return {
    ok: errors.length === 0,
    errors,
    summary: errors.length === 0
      ? '引用关系自洽，可以装载。'
      : `有 ${errors.length} 处引用问题，装载会让工具静默返回空值。`,
  }
}
