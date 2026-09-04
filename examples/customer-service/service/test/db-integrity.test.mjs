import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

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
