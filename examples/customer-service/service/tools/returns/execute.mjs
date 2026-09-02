import { clean, guardVerified, toolResult } from '../shared.mjs'
import {
  APPROVAL_ERROR_TEXT,
  approvalPrompt,
  consumeApproval,
  createApproval,
} from '../approval.mjs'

// 退货时限表，抄自 domains/retail/policy.md 第二条。
// 【furniture 刻意不在表里】—— 细则确实没写家具类的窗口。
// 查不到时返回「细则未覆盖，需转人工」，而不是挑一个看起来合理的天数。
// 这是「不许编造」的机制保证：不靠 prompt 请模型别编，而是工具本身给不出数字。
const RETURN_WINDOW_DAYS = Object.freeze({
  apparel: 30,
  accessory: 30,
  digital: 7,
  appliance: 15,
})

const CATEGORY_TEXT = Object.freeze({
  apparel: '服饰鞋包',
  accessory: '配件',
  digital: '数码电子',
  appliance: '家用电器',
  furniture: '家具',
})

// 细则第六条与第九条：超过这个数不自行处理，转人工主管。
const REFUND_CEILING = 2000

function daysSince(iso) {
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

  // 写库类工具在未核验时一律拒绝。理由和只读类不同：只读是防泄露，
  // 这里是防「改了不该改的人的单」—— 没有 ownerId 连该改谁都不知道。
  const warning = guardVerified(session, name)
  if (warning) {
    return finish(store, sessionId, surface, name,
      '需要先核验客户身份才能办理这项业务。', false,
      { blocked: 'identity_required' }, null, warning)
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
    // 数据合法性校验（第 1 层，硬保证）。照 τ² 的做法：工具只管数据本身
    // 合不合法，不管流程顺序对不对。
    if (order.status !== 'pending') {
      return finish(store, sessionId, surface, name,
        `这笔订单当前是「${order.status === 'shipped' ? '已发货'
          : order.status === 'delivered' ? '已签收' : '已取消'}」，不能取消。`
        + (order.status === 'shipped' ? '可以引导客户签收后办退货，或者拒收。' : ''),
        false, { blocked: 'not_pending' }, null, null)
    }
    const reason = clean(args.reason)
    if (!['不需要了', '买错了'].includes(reason)) {
      return finish(store, sessionId, surface, name,
        '取消原因只能是「不需要了」或「买错了」，请把客户的说法归到最接近的一种。',
        false, {}, null, null)
    }

    // 【超上限的不发令牌】没有令牌就执行不了，所以这条上限不是提示而是拦截。
    // 若只在预览里写「金额较大建议转人工」，模型完全可以照样往下走。
    if (order.total > REFUND_CEILING) {
      return finish(store, sessionId, surface, name,
        `退款金额 ￥${order.total.toFixed(2)} 超过 ￥${REFUND_CEILING} 上限，`
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
    if (order.status !== 'delivered') {
      return finish(store, sessionId, surface, name,
        order.status === 'pending'
          ? '这笔还没发货，退货流程不适用，应该走取消订单。'
          : order.status === 'shipped'
            ? '这笔已发货但还没签收，可以引导客户拒收，签收后才能办退货。'
            : '这笔已经取消了，不能退货。',
        false, { blocked: 'not_delivered' }, null, null)
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

    // 资格判定：按类别查时限。这一步的依据在 policy 里，不在数据库里 ——
    // 也是这个示例最想验证的东西。
    const elapsed = daysSince(order.deliveredAt)
    const uncovered = []
    const expired = []
    for (const item of targets) {
      const category = productOf(db, item)?.category
      const window = RETURN_WINDOW_DAYS[category]
      if (window === undefined) {
        uncovered.push(`${productOf(db, item)?.name}（${CATEGORY_TEXT[category] || category}）`)
      } else if (elapsed > window) {
        expired.push(`${productOf(db, item)?.name}（${CATEGORY_TEXT[category]}类 ${window} 天）`)
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
    if (amount > REFUND_CEILING) {
      return finish(store, sessionId, surface, name,
        `退款金额 ￥${amount.toFixed(2)} 超过 ￥${REFUND_CEILING} 上限，客服不能自行处理。`
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
    if (order.status !== 'pending') {
      return finish(store, sessionId, surface, name,
        `这笔订单当前是「${order.status === 'shipped' ? '已发货'
          : order.status === 'delivered' ? '已签收' : '已取消'}」，不能改地址。`
        + (order.status === 'shipped'
          ? '可以引导客户签收后自行处理，或者拒收后重新下单。' : ''),
        false, { blocked: 'not_pending' }, null, null)
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
