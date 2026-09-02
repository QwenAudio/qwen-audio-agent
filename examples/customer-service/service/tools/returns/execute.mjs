import { clean, toolResult } from '../shared.mjs'
import { checkPreconditions, decide, enumValues, loadGuards } from '../../guards.mjs'
import {
  APPROVAL_ERROR_TEXT,
  approvalPrompt,
  consumeApproval,
  createApproval,
} from '../approval.mjs'

// 【业务规则不在这个文件里，在 domains/*/guards.json】
// 退货时限表、退款上限、哪些状态能取消，原本都硬编码在这里。
// 搬到配置之后，管理员在配置台改一个数字就能改变行为 ——
// 而不是提一个改代码的需求。
//
// 这里只保留两件事：从 db 取出决策所需的输入（类别、天数、状态、金额），
// 以及把决策结果翻成给模型看的话。
//
// 曾经反对「工具级状态机」的理由是「前置条件随场景变、硬编码会把场景差异
// 写进工具定义、枚举不全那个场景就不能用」。配置化解决前两点；
// 第三点靠 guards.mjs 的缺省放行解决 —— 漏声明只是少一道保护。

const CATEGORY_TEXT = Object.freeze({
  apparel: '服饰鞋包',
  accessory: '配件',
  digital: '数码电子',
  appliance: '家用电器',
  furniture: '家具',
})

const STATUS_TEXT = Object.freeze({
  pending: '未发货',
  shipped: '已发货',
  delivered: '已签收',
  cancelled: '已取消',
})

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

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

function productOf(db, item) {
  return db.products.find(entry => entry.productId === item.productId)
}

// 退款到账说明来自细则第六条。礼品卡即时、其余 3-7 个工作日。
// 混合支付要分别说明，否则客户以为全部即时到账。
function refundNarrative(order, user, amount) {
  const method = user.paymentMethods.find(entry => entry.id === order.payment.methodId)
  if (method?.type === 'gift_card') {
    return `￥${amount.toFixed(2)} 将即时退回礼品卡余额`
  }
  const label = method?.type === 'alipay' ? '支付宝' : `${method?.brand || ''}信用卡`
  return `￥${amount.toFixed(2)} 将退回${label}，3 到 7 个工作日到账`
}

function finish(store, sessionId, surface, tool, content, changed, data, summary, warning) {
  store.appendAudit(sessionId, {
    tool, surface, ok: !warning && changed !== false, summary: summary || content, warning,
  })
  return toolResult(content, store.mutable(sessionId), changed, data)
}

export function executeReturnsTool(name, args, { store, sessionId, surface }) {
  const session = store.mutable(sessionId)
  const guards = loadGuards(session.domain)

  if (name === 'transfer_to_human') {
    const reason = clean(args.reason)
    if (!reason) {
      return finish(store, sessionId, surface, name,
        '转接需要写明原因，一句话说清为什么自己办不了。', false, {}, null, null)
    }
    session.transferred = { at: Date.now(), reason }
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `已转接人工，原因：${reason}。请告知客户「正在为您转接人工，请稍等」。`,
      true, { transferred: true }, `转人工：${reason}`, null)
  }

  // 前置条件改从 guards.json 读。之前是写死的 guardVerified，
  // 现在管理员可以改「退货到底需要先确认什么」。
  const gate = checkPreconditions(guards, name, session)
  if (!gate.ok) {
    return finish(store, sessionId, surface, name, gate.message, false,
      { blocked: 'precondition', missing: gate.missing },
      null, `${name} 缺前置条件：${gate.missing.join('、')}`)
  }

  const ownerId = session.identity.userId
  const { db } = session
  const located = locateOrder(db, ownerId, args.orderId)
  if (located.ambiguous) {
    return finish(store, sessionId, surface, name,
      `后四位对应到 ${located.ambiguous.length} 笔订单：${located.ambiguous.join('、')}。`
      + '请让客户念出完整订单号。', false, { ambiguous: located.ambiguous }, null, null)
  }
  if (!located.order) {
    return finish(store, sessionId, surface, name,
      '在这位客户名下没有找到这笔订单，请确认订单号。', false, { found: false },
      `未找到订单 ${clean(args.orderId)}`, null)
  }
  const order = located.order
  const user = db.users.find(entry => entry.userId === ownerId)
  const token = clean(args.approval_token)

  if (name === 'cancel_order') {
    // 哪些状态能取消改从决策表读。之前写死为 status !== 'pending'。
    const cancellable = decide(guards, 'cancellable', { status: order.status })
    if (cancellable.outcome !== 'allow') {
      const detail = cancellable.reason || `当前状态「${STATUS_TEXT[order.status] || order.status}」不允许取消`
      return finish(store, sessionId, surface, name,
        `这笔订单不能取消：${detail}。`,
        false, { blocked: 'not_cancellable' }, null, null)
    }
    const allowedReasons = enumValues(guards, 'cancel_reason')
    const reason = clean(args.reason)
    if (allowedReasons && !allowedReasons.includes(reason)) {
      return finish(store, sessionId, surface, name,
        `取消原因只能是${allowedReasons.map(item => `「${item}」`).join('或')}，`
        + '请把客户的说法归到最接近的一种。',
        false, {}, null, null)
    }

    // 【超上限的不发令牌】没有令牌就执行不了，所以这条上限不是提示而是拦截。
    // 阈值现在从 guards.json 的 refund_authority 表里读。
    const authority = decide(guards, 'refund_authority', { amount: order.total })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `退款金额 ￥${order.total.toFixed(2)} ${authority.reason || '超出客服权限'}，`
        + '客服不能自行处理。请向客户说明需要主管审批，然后调用 transfer_to_human。',
        false, { blocked: 'over_ceiling', total: order.total },
        `退款 ￥${order.total.toFixed(2)} 超上限，需转人工`, null)
    }

    if (!token) {
      const items = order.items
        .map(item => `${productOf(db, item)?.name || item.productId} ×${item.quantity}`)
        .join('、')
      const preview = `将取消订单 ${order.orderId}：${items}，`
        + `${refundNarrative(order, user, order.total)}。原因记为「${reason}」。`
      const created = createApproval(session, {
        action: 'cancel_order', subject: order.orderId, preview,
        effect: { reason },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true }, `取消 ${order.orderId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'cancel_order', subject: order.orderId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    order.status = 'cancelled'
    order.cancelledAt = new Date().toISOString()
    order.cancelReason = consumed.effect.reason
    order.payment.transactions.push({ type: 'refund', amount: order.total })
    const method = user.paymentMethods.find(entry => entry.id === order.payment.methodId)
    if (method?.type === 'gift_card') {
      method.balance = Math.round((method.balance + order.total) * 100) / 100
    }
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `订单 ${order.orderId} 已取消，${refundNarrative(order, user, order.total)}。`,
      true, { cancelled: true, refund: order.total },
      `取消 ${order.orderId}，退款 ￥${order.total.toFixed(2)}`, null)
  }

  if (name === 'return_items') {
    // 哪些状态能退货改从决策表读。
    const returnable = decide(guards, 'returnable_status', { status: order.status })
    if (returnable.outcome !== 'allow') {
      return finish(store, sessionId, surface, name,
        returnable.reason || `当前状态「${STATUS_TEXT[order.status] || order.status}」不能退货。`,
        false, { blocked: 'not_returnable' }, null, null)
    }

    const wanted = Array.isArray(args.itemIds) ? args.itemIds.map(clean).filter(Boolean) : []
    const targets = wanted.length
      ? order.items.filter(item => wanted.includes(item.itemId))
      : order.items
    if (!targets.length) {
      return finish(store, sessionId, surface, name,
        '指定的款式不在这笔订单里。请用 get_order 核对款式编号。',
        false, { blocked: 'item_not_in_order' }, null, null)
    }
    if (order.returnedItemIds?.length) {
      const already = targets.filter(item => order.returnedItemIds.includes(item.itemId))
      if (already.length) {
        return finish(store, sessionId, surface, name,
          `${already.map(item => productOf(db, item)?.name).join('、')}已经退过了，不能重复退。`,
          false, { blocked: 'already_returned' }, null, null)
      }
    }

    // 资格判定：逐件过 return_window 决策表。
    // 【“policy_gap” 是表里的兜底行，不是代码里的 undefined 分支】
    // 家具类在 policy 里没写时限，表里也就没有它，兜底行把它导向
    // 转人工 —— 而不是猜一个天数。这是「不许编造」的机制形态。
    const elapsed = daysSince(order.deliveredAt)
    const uncovered = []
    const expired = []
    for (const item of targets) {
      const product = productOf(db, item)
      const verdict = decide(guards, 'return_window', {
        category: product?.category,
        daysSinceDelivery: elapsed,
      })
      if (!verdict.available || verdict.outcome === 'policy_gap') {
        uncovered.push(`${product?.name}（${CATEGORY_TEXT[product?.category] || product?.category}）`)
      } else if (verdict.outcome === 'expired') {
        expired.push(`${product?.name}（${verdict.reason || '超出时限'}）`)
      }
    }
    if (uncovered.length) {
      return finish(store, sessionId, surface, name,
        `细则里没有规定 ${uncovered.join('、')} 这一类的退货时限，`
        + '不要自行判断或估算。请向客户说明需要人工确认，然后调用 transfer_to_human。',
        false, { blocked: 'policy_gap' },
        `细则未覆盖：${uncovered.join('、')}`, null)
    }
    if (expired.length) {
      return finish(store, sessionId, surface, name,
        `这笔订单签收已 ${elapsed} 天，${expired.join('、')}已超出退货时限，不能受理。`,
        false, { blocked: 'window_expired', elapsed },
        `超出时限 ${elapsed} 天，拒绝退货`, null)
    }

    const amount = Math.round(
      targets.reduce((acc, item) => acc + item.price * item.quantity, 0) * 100,
    ) / 100
    const authority = decide(guards, 'refund_authority', { amount })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `退款金额 ￥${amount.toFixed(2)} ${authority.reason || '超出客服权限'}，客服不能自行处理。`
        + '请向客户说明需要主管审批，然后调用 transfer_to_human。',
        false, { blocked: 'over_ceiling', amount },
        `退款 ￥${amount.toFixed(2)} 超上限，需转人工`, null)
    }

    // subject 里带上款式：部分退货时，「退耳机」的批准不该能拿去退鼠标。
    const subject = `${order.orderId}#${targets.map(item => item.itemId).sort().join(',')}`
    if (!token) {
      const list = targets
        .map(item => `${productOf(db, item)?.name} ×${item.quantity}`)
        .join('、')
      const preview = `将为订单 ${order.orderId} 办理退货：${list}，`
        + `${refundNarrative(order, user, amount)}。签收已 ${elapsed} 天，在时限内。`
      const created = createApproval(session, {
        action: 'return_items', subject, preview,
        effect: { itemIds: targets.map(item => item.itemId), amount },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true, amount }, `退货 ${order.orderId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, { action: 'return_items', subject, token })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    order.returnedItemIds = [...(order.returnedItemIds || []), ...consumed.effect.itemIds]
    order.payment.transactions.push({ type: 'refund', amount: consumed.effect.amount })
    const method = user.paymentMethods.find(entry => entry.id === order.payment.methodId)
    if (method?.type === 'gift_card') {
      method.balance = Math.round((method.balance + consumed.effect.amount) * 100) / 100
    }
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `退货已受理，${refundNarrative(order, user, consumed.effect.amount)}。`
      + '请告知客户把商品按原包装寄回。',
      true, { returned: true, refund: consumed.effect.amount },
      `退货 ${order.orderId}，退款 ￥${consumed.effect.amount.toFixed(2)}`, null)
  }

  if (name === 'modify_address') {
    const editable = decide(guards, 'address_editable', { status: order.status })
    if (editable.outcome !== 'allow') {
      return finish(store, sessionId, surface, name,
        editable.reason || `当前状态「${STATUS_TEXT[order.status] || order.status}」不能改地址。`,
        false, { blocked: 'not_editable' }, null, null)
    }
    const address = clean(args.address)
    if (address.length < 6) {
      return finish(store, sessionId, surface, name,
        '新地址太短，请向客户问清省市区与门牌号。', false, {}, null, null)
    }

    if (!token) {
      const preview = `将把订单 ${order.orderId} 的收货地址改为：${address}`
      const created = createApproval(session, {
        action: 'modify_address', subject: order.orderId, preview, effect: { address },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true }, `改地址 ${order.orderId} 待客户确认`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'modify_address', subject: order.orderId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    order.address = consumed.effect.address
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `订单 ${order.orderId} 的收货地址已改为：${consumed.effect.address}`,
      true, { updated: true }, `改地址 ${order.orderId}`, null)
  }

  throw new Error(`Unknown returns action: ${name}`)
}
