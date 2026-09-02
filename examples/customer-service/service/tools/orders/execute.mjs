import { clean, toolResult, truncateForVoice } from '../shared.mjs'
import { checkPreconditions, loadGuards } from '../../guards.mjs'

const STATUS_TEXT = Object.freeze({
  pending: '未发货',
  shipped: '已发货',
  delivered: '已签收',
  cancelled: '已取消',
})

const CATEGORY_TEXT = Object.freeze({
  apparel: '服饰鞋包',
  accessory: '配件',
  digital: '数码电子',
  appliance: '家用电器',
  furniture: '家具',
})

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

// 语音说 "#W2378156" 很容易错一位，所以支持后四位匹配。
// 但【后四位可能撞】——撞了必须说清楚而不是随便挑一个，
// 否则客服会拿着错的订单往下走，后面每一步都错。
function locateOrder(db, ownerId, raw) {
  const needle = clean(raw).replace(/^#/, '')
  const mine = db.orders.filter(order => order.userId === ownerId)
  const exact = mine.find(order => order.orderId.replace(/^#/, '') === needle)
  if (exact) return { order: exact }
  if (needle.length >= 3 && needle.length < 8) {
    const tail = mine.filter(order => order.orderId.endsWith(needle))
    if (tail.length === 1) return { order: tail[0] }
    if (tail.length > 1) return { ambiguous: tail.map(order => order.orderId) }
  }
  return {}
}

function describeOrder(order, db) {
  const lines = [`${order.orderId}　${STATUS_TEXT[order.status]}　￥${order.total.toFixed(2)}`]
  for (const item of order.items) {
    const product = db.products.find(entry => entry.productId === item.productId)
    const variant = product?.variants.find(entry => entry.itemId === item.itemId)
    const options = variant ? Object.values(variant.options).join('/') : ''
    lines.push(`　· ${product?.name || item.productId}${options ? `（${options}）` : ''}`
      + `　×${item.quantity}　￥${item.price.toFixed(2)}`
      // 类别与签收天数是【判定退换资格的两个必要输入】，
      // 所以在订单详情里直接给出，省掉一次「这是什么类别」的往返。
      + `　类别：${CATEGORY_TEXT[product?.category] || product?.category || '未知'}`)
  }
  if (order.status === 'delivered') {
    lines.push(`　签收于 ${order.deliveredAt.slice(0, 10)}，距今 ${daysSince(order.deliveredAt)} 天`)
  }
  if (order.status === 'shipped') lines.push(`　发货于 ${order.shippedAt.slice(0, 10)}`)
  if (order.status === 'cancelled') lines.push(`　取消于 ${order.cancelledAt.slice(0, 10)}`)
  return lines.join('\n')
}

export function executeOrdersTool(name, args, { store, sessionId, surface }) {
  const session = store.mutable(sessionId)
  const guards = loadGuards(session.domain)
  const gate = checkPreconditions(guards, name, session)

  // 【前置条件从 guards.json 读，不再写死】
  // 这三个工具返回的是客户账户信息，说出去就收不回来，所以 onMissing
  // 配的是 refuse：拒绝执行 + 留下红色审计记录。
  // 管理员如果把某个只读工具的前置条件去掉，这里就不拦了 ——
  // 那是他的决定，不是代码的默认。
  if (!gate.ok) {
    store.appendAudit(sessionId, {
      tool: name, surface, ok: false, summary: gate.message,
      warning: `${name} 缺前置条件：${gate.missing.join('、')}`,
    })
    return toolResult(gate.message, session, false,
      { blocked: 'precondition', missing: gate.missing })
  }

  const ownerId = session.identity.userId
  const { db } = session

  if (name === 'list_orders') {
    const status = clean(args.status)
    let mine = db.orders.filter(order => order.userId === ownerId)
    if (status) mine = mine.filter(order => order.status === status)
    mine.sort((left, right) => new Date(right.placedAt) - new Date(left.placedAt))

    if (!mine.length) {
      const content = status
        ? `没有${STATUS_TEXT[status]}的订单。`
        : '这位客户名下没有订单。'
      store.appendAudit(sessionId, { tool: name, surface, ok: true, summary: content })
      return toolResult(content, session, false, { count: 0 })
    }

    const { shown, rest } = truncateForVoice(mine)
    const body = shown
      .map(order => `${order.orderId}　${STATUS_TEXT[order.status]}　￥${order.total.toFixed(2)}`
        + `　下单于 ${order.placedAt.slice(0, 10)}`)
      .join('\n')
    const content = rest
      ? `共 ${mine.length} 笔，先说最近三笔：\n${body}\n还有 ${rest} 笔，需要的话再往下报。`
      : `共 ${mine.length} 笔：\n${body}`
    store.appendAudit(sessionId, {
      tool: name, surface, ok: true, summary: `列出 ${mine.length} 笔订单`,
    })
    return toolResult(content, session, false, { count: mine.length })
  }

  if (name === 'get_order') {
    const located = locateOrder(db, ownerId, args.orderId)
    if (located.ambiguous) {
      const content = `后四位对应到 ${located.ambiguous.length} 笔订单：`
        + `${located.ambiguous.join('、')}。请让客户念出完整订单号。`
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, { ambiguous: located.ambiguous })
    }
    if (!located.order) {
      // 【不区分「不存在」与「不是这位客户的」】两种情况都回同一句话。
      // 若分开回答，来电者就能靠试探得知某个订单号是否属于别人 —— 细则第十条。
      const content = '在这位客户名下没有找到这笔订单，请确认订单号。'
      store.appendAudit(sessionId, {
        tool: name, surface, ok: false, summary: `未找到订单 ${clean(args.orderId)}`,
      })
      return toolResult(content, session, false, { found: false })
    }
    const order = located.order
    store.appendAudit(sessionId, {
      tool: name, surface, ok: true, summary: `查看订单 ${order.orderId}`,
    })
    return toolResult(describeOrder(order, db), session, false, {
      found: true,
      orderId: order.orderId,
      status: order.status,
      total: order.total,
      deliveredDays: daysSince(order.deliveredAt),
    })
  }

  if (name === 'check_variant') {
    const productId = clean(args.productId)
    const product = db.products.find(entry => entry.productId === productId)
    if (!product) {
      const content = `没有编号为 ${productId} 的商品。`
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, { found: false })
    }
    const body = product.variants
      .map(variant => `　· ${Object.values(variant.options).join('/')}`
        + `　￥${variant.price.toFixed(2)}`
        + `　${variant.stock > 0 ? `有货（${variant.stock}）` : '无货'}`)
      .join('\n')
    store.appendAudit(sessionId, {
      tool: name, surface, ok: true, summary: `查看 ${product.name} 的款式库存`,
    })
    return toolResult(`${product.name}（${CATEGORY_TEXT[product.category] || product.category}）：\n${body}`,
      session, false, {
        found: true,
        productId,
        inStock: product.variants.filter(variant => variant.stock > 0).length,
      })
  }

  throw new Error(`Unknown orders action: ${name}`)
}
