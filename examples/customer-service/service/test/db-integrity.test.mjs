import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomerService } from '../service.mjs'

// db.json 是手写的，20 个订单 × 每个订单多个 itemId 引用 —— 手写必然有错。
// 这些断言不是「测代码」，是【测数据】：裁剪自 τ² 的库必须自洽，
// 否则 executor 会在运行时拿到 undefined，而那时排查成本高得多。

const db = JSON.parse(readFileSync(
  new URL('../../domains/retail/db.json', import.meta.url), 'utf8',
))

test('用户 id 唯一', () => {
  const ids = db.users.map(user => user.userId)
  assert.equal(new Set(ids).size, ids.length)
})

test('订单 id 唯一', () => {
  const ids = db.orders.map(order => order.orderId)
  assert.equal(new Set(ids).size, ids.length)
})

test('变体 itemId 全局唯一', () => {
  const ids = db.products.flatMap(p => p.variants.map(v => v.itemId))
  assert.equal(new Set(ids).size, ids.length)
})

test('每个订单的 userId 都能找到用户', () => {
  const users = new Set(db.users.map(user => user.userId))
  for (const order of db.orders) {
    assert.ok(users.has(order.userId), `${order.orderId} 的 userId 不存在: ${order.userId}`)
  }
})

test('每个订单条目的 itemId 与 productId 都能对上', () => {
  const variantOwner = new Map()
  for (const product of db.products) {
    for (const variant of product.variants) variantOwner.set(variant.itemId, product.productId)
  }
  for (const order of db.orders) {
    for (const item of order.items) {
      assert.ok(variantOwner.has(item.itemId), `${order.orderId} 引用了不存在的变体: ${item.itemId}`)
      assert.equal(
        variantOwner.get(item.itemId), item.productId,
        `${order.orderId} 的 ${item.itemId} 属于 ${variantOwner.get(item.itemId)}，不是 ${item.productId}`,
      )
    }
  }
})

test('订单支付方式属于下单用户', () => {
  const owned = new Map(db.users.map(user => [
    user.userId, new Set(user.paymentMethods.map(method => method.id)),
  ]))
  for (const order of db.orders) {
    assert.ok(
      owned.get(order.userId).has(order.payment.methodId),
      `${order.orderId} 用了不属于 ${order.userId} 的支付方式: ${order.payment.methodId}`,
    )
  }
})

test('订单总额等于条目金额之和', () => {
  for (const order of db.orders) {
    const sum = order.items.reduce((acc, item) => acc + item.price * item.quantity, 0)
    assert.equal(
      Math.round(sum * 100), Math.round(order.total * 100),
      `${order.orderId} 总额 ${order.total} 与条目之和 ${sum} 不符`,
    )
  }
})

test('付款流水金额等于订单总额', () => {
  for (const order of db.orders) {
    const paid = order.payment.transactions
      .filter(item => item.type === 'payment')
      .reduce((acc, item) => acc + item.amount, 0)
    assert.equal(
      Math.round(paid * 100), Math.round(order.total * 100),
      `${order.orderId} 付款流水 ${paid} 与总额 ${order.total} 不符`,
    )
  }
})

test('已取消的订单必须有等额退款流水', () => {
  for (const order of db.orders.filter(item => item.status === 'cancelled')) {
    const refunded = order.payment.transactions
      .filter(item => item.type === 'refund')
      .reduce((acc, item) => acc + item.amount, 0)
    assert.equal(
      Math.round(refunded * 100), Math.round(order.total * 100),
      `${order.orderId} 已取消但退款金额是 ${refunded}`,
    )
  }
})

test('状态与时间戳一致', () => {
  for (const order of db.orders) {
    if (order.status === 'delivered') {
      assert.ok(order.deliveredAt, `${order.orderId} 状态 delivered 但没有 deliveredAt`)
      assert.ok(
        new Date(order.deliveredAt) >= new Date(order.placedAt),
        `${order.orderId} 的收货时间早于下单时间`,
      )
    }
    if (order.status === 'shipped') assert.ok(order.shippedAt, `${order.orderId} 缺 shippedAt`)
    if (order.status === 'cancelled') assert.ok(order.cancelledAt, `${order.orderId} 缺 cancelledAt`)
    // pending 反过来不能有这些时间戳，否则「能不能取消」的判定会走偏
    if (order.status === 'pending') {
      assert.equal(order.shippedAt, undefined, `${order.orderId} 是 pending 却有 shippedAt`)
      assert.equal(order.deliveredAt, undefined, `${order.orderId} 是 pending 却有 deliveredAt`)
    }
  }
})

// 下面几条守的是【场景覆盖】而不是数据合法性：计划 §3.1 列了 6 个零售场景，
// 每个都需要特定形态的订单。少了哪一类，对应场景就没法演示。
test('场景覆盖：四种订单状态都有', () => {
  const statuses = new Set(db.orders.map(order => order.status))
  for (const wanted of ['pending', 'shipped', 'delivered', 'cancelled']) {
    assert.ok(statuses.has(wanted), `缺少 ${wanted} 状态的订单`)
  }
})

test('场景覆盖：有用户没有邮箱（逼出 name+zip 核验分支）', () => {
  assert.ok(db.users.some(user => !user.email), '所有用户都有邮箱，核验的第二条分支测不到')
})

test('场景覆盖：有订单金额超过 2000 元退款上限（转人工用例）', () => {
  assert.ok(
    db.orders.some(order => order.status === 'pending' && order.total > 2000),
    '没有超过退款上限的可取消订单，转人工场景测不到',
  )
})

test('场景覆盖：键盘有 clicky 轴的变体且有货（换货主场景）', () => {
  const keyboard = db.products.find(product => product.productId === 'P_KEYBOARD')
  assert.ok(
    keyboard.variants.some(v => v.options.switch === 'clicky' && v.stock > 0),
    '换货目标变体无货，主场景走不通',
  )
})

test('场景覆盖：有缺货变体（库存校验用例）', () => {
  assert.ok(
    db.products.some(product => product.variants.some(variant => variant.stock === 0)),
    '所有变体都有货，库存校验测不到',
  )
})

// ── 日期锚定：这个 demo 不该随时间腐烂 ──

test('两个域都声明了 _anchorDate', () => {
  // 【这条守着一个真实的腐烂】
  // db.json 里的 deliveredAt 是写死的。写它那天 #W2094558 是「3 天前签收」，
  // 在 digital 类 7 天窗口内。一周之后它变成 8 天，退货测试就红了，
  // 而代码一行没改 —— 我是在别的改动之后跑全量才发现两条早已在挂。
  for (const domain of ['retail', 'airline']) {
    const raw = JSON.parse(readFileSync(
      new URL(`../../domains/${domain}/db.json`, import.meta.url), 'utf8',
    ))
    assert.ok(raw._anchorDate, `${domain} 缺 _anchorDate`)
    assert.ok(!Number.isNaN(new Date(raw._anchorDate).getTime()),
      `${domain} 的 _anchorDate 不是合法时间`)
  }
})

test('装载之后没有「未来的过去事件」', () => {
  // 平移量算错就会让 bookedAt / deliveredAt 跑到未来 ——
  // 那时「出票 24 小时内可免费退」这类判定全乱，而且症状很怪：
  // 客户刚下的单显示成负天数。
  for (const domain of ['retail', 'airline']) {
    const db = new CustomerService().snapshot(`anchor-${domain}`, domain).db
    for (const order of db.orders || []) {
      for (const field of ['placedAt', 'deliveredAt', 'shippedAt']) {
        if (!order[field]) continue
        assert.ok(new Date(order[field]).getTime() <= Date.now() + 60_000,
          `${order.orderId} 的 ${field} 在未来`)
      }
    }
    for (const reservation of db.reservations || []) {
      assert.ok(new Date(reservation.bookedAt).getTime() <= Date.now() + 60_000,
        `${reservation.reservationId} 的出票时间在未来`)
    }
  }
})

test('零售的签收天数分布跨过每一个退货时限', () => {
  // 平移之后每个时限的两侧都要有样本，否则「可退」和「拒退」只能演一半。
  // 这一条同时守着锚点没被改坏 —— 锚点偏一天，某个边界就可能空出来。
  const db = new CustomerService().snapshot('anchor-window', 'retail').db
  const daysOf = order => Math.floor(
    (Date.now() - new Date(order.deliveredAt).getTime()) / 86_400_000,
  )
  const byCategory = new Map()
  for (const order of db.orders) {
    if (!order.deliveredAt) continue
    for (const line of order.items || []) {
      const product = db.products.find(item => item.productId === line.productId)
      if (!product) continue
      if (!byCategory.has(product.category)) byCategory.set(product.category, [])
      byCategory.get(product.category).push(daysOf(order))
    }
  }
  // digital 的窗口是 7 天：两侧都要有
  const digital = byCategory.get('digital') || []
  assert.ok(digital.some(days => days <= 7), `digital 没有 7 天内的样本：${digital}`)
  assert.ok(digital.some(days => days > 7), `digital 没有超期样本：${digital}`)
})

test('航空的出票时长与航班状态都还原了写测试那天的事实', () => {
  const db = new CustomerService().snapshot('anchor-air', 'airline').db
  const hoursOf = iso => (Date.now() - new Date(iso).getTime()) / 3_600_000

  // 退票测试要求这三笔「超 24 小时」—— 它们分别验特价舱不可退、
  // 公务舱可退、有保险走保险。任一笔落进 24 小时内，那三条断言就测的是别的分支。
  for (const id of ['CYR8806', 'CYR8807', 'CYR8808']) {
    const reservation = db.reservations.find(item => item.reservationId === id)
    assert.ok(hoursOf(reservation.bookedAt) > 24,
      `${id} 出票只有 ${hoursOf(reservation.bookedAt).toFixed(1)} 小时，落进了 24 小时窗口`)
  }
  // 已飞、已取消、延误各要有至少一班 —— 三种状态分别支撑不同的判定
  const statuses = new Set(db.flights.map(flight => flight.status))
  for (const status of ['flown', 'cancelled', 'delayed']) {
    assert.ok(statuses.has(status), `没有 status=${status} 的航班`)
  }
})

test('航段指向的航班在平移之后仍然对得上', () => {
  // 【这条的强度有限，如实记下来】
  // 航段和航班用的是【同一个字段名】date，所以平移逻辑要么都作用要么都不作用，
  // 两边永远一致。试过两个突变都没能让它变红：
  //   从 DATE_FIELDS 里去掉 'date'       → 两边都不平移，仍然相等
  //   让纯日期字段也带上时刻            → 两边都变 ISO，仍然相等
  //
  // 所以它守的不是「断链」，是「平移之后引用关系还在」这个更弱的性质 ——
  // 真正能断链的改动是给两类字段用不同的平移量，而现在的实现结构上做不到。
  // 留着它有价值：将来若有人把航班日期改成从别处算，这条会红。
  const db = new CustomerService().snapshot('anchor-seg', 'airline').db
  for (const reservation of db.reservations) {
    for (const segment of reservation.segments) {
      const flight = db.flights.find(item => (
        item.flightNo === segment.flightNo && item.date === segment.date
      ))
      assert.ok(flight,
        `${reservation.reservationId} 的航段 ${segment.flightNo}@${segment.date} 找不到航班`)
    }
  }
})

test('纯日期字段平移后仍是 YYYY-MM-DD', () => {
  // 航班的 date 是纯日期。平移时若直接 toISOString() 会变成带时刻的长串，
  // 而工具里到处按 YYYY-MM-DD 比较和显示（get_flight_status 的话术、
  // search_flights 的候选列表）。这一条比上面那条更能测到格式问题。
  const db = new CustomerService().snapshot('anchor-fmt', 'airline').db
  for (const flight of db.flights) {
    assert.match(flight.date, /^\d{4}-\d{2}-\d{2}$/,
      `${flight.flightNo} 的 date 变成了 ${flight.date}`)
  }
  for (const reservation of db.reservations) {
    for (const segment of reservation.segments) {
      assert.match(segment.date, /^\d{4}-\d{2}-\d{2}$/,
        `${reservation.reservationId} 的航段日期变成了 ${segment.date}`)
    }
  }
})
