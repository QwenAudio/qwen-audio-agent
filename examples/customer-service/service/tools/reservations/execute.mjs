import { clean, toolResult, truncateForVoice } from '../shared.mjs'
import { checkPreconditions, decide, enumValues, loadGuards } from '../../guards.mjs'
import {
  APPROVAL_ERROR_TEXT,
  approvalPrompt,
  consumeApproval,
  createApproval,
} from '../approval.mjs'

// 航空域的工具。只读三个（列预订、预订详情、航班状态）加退票与转人工。
// 改签、改舱位、加行李、发补偿在下一批。
//
// 退票走两段式批准：第一次调用只返回预览和一枚令牌，不碰数据库；
// 拿着令牌再调一次才真正执行。理由见 tools/approval.mjs ——
// 把「流程约束」变成「数据依赖」，模型绕不过去。
//
// 【为什么只读工具也要过 preconditions】
// 预订里有乘客姓名、证件后四位、支付方式后四位 —— 说出去就收不回来。
// 细则第十条：不得在核验身份前确认或否认某个订单是否存在。
// 所以这三个工具在 guards.json 里都声明了 identity_verified。

const CABIN_TEXT = Object.freeze({
  basic_economy: '特价经济舱',
  economy: '经济舱',
  business: '公务舱',
})

const TIER_TEXT = Object.freeze({
  regular: '普通会员',
  silver: '银卡会员',
  gold: '金卡会员',
})

const FLIGHT_STATUS_TEXT = Object.freeze({
  on_time: '正常',
  delayed: '延误',
  cancelled: '已取消',
  flown: '已执飞',
})

function flightOf(db, flightNo, date) {
  const matches = db.flights.filter(flight => (
    flight.flightNo === flightNo && (!date || flight.date === date)
  ))
  // 【同一航班号可能有多天】不填日期又匹配到多班时不能随便挑一班 ——
  // 客户问的是具体某天，答错一天等于答错一个航班。
  if (matches.length > 1) return { ambiguous: matches }
  return { flight: matches[0] || null }
}

// 已飞航段是改签、改舱位、退票三处判定的共同输入，所以单独抽出来。
function hasFlownSegment(db, reservation) {
  return reservation.segments.some(segment => {
    const { flight } = flightOf(db, segment.flightNo, segment.date)
    return flight?.status === 'flown'
  })
}

// 航司取消的航班：只要有任一航段被取消就算。
// 【不要求全部取消】往返行程去程被取消也使整个行程不成立，
// 那时客户有权全额退 —— 细则第六条「航班被航司取消」没限定“全部”。
function cancelledByAirline(db, reservation) {
  return reservation.segments.some(segment => {
    const { flight } = flightOf(db, segment.flightNo, segment.date)
    return flight?.status === 'cancelled'
  })
}

function hoursSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY
  return (Date.now() - new Date(iso).getTime()) / 3_600_000
}

// 退款到账时间按支付方式说，不编数字 —— 细则第九条写的就这两种。
function refundNarrative(user, reservation, amount) {
  const method = user?.paymentMethods?.find(item => item.id === reservation.payment.methodId)
  if (!method) return `￥${amount.toFixed(2)} 将退回原支付方式`
  return method.type === 'gift_card'
    ? `￥${amount.toFixed(2)} 将即时退回礼品卡`
    : `￥${amount.toFixed(2)} 将退回${method.brand}信用卡，3 到 7 个工作日到账`
}

function describeSegments(db, reservation) {
  return reservation.segments.map(segment => {
    const { flight } = flightOf(db, segment.flightNo, segment.date)
    if (!flight) return `　· ${segment.flightNo}　${segment.date}　（查不到航班信息）`
    const status = FLIGHT_STATUS_TEXT[flight.status] || flight.status
    const delay = flight.status === 'delayed' && flight.delayHours
      ? `，延误 ${flight.delayHours} 小时`
      : ''
    return `　· ${flight.flightNo}　${flight.from} → ${flight.to}　${flight.date}`
      + ` ${flight.departure}-${flight.arrival}　${status}${delay}`
  }).join('\n')
}

export function executeReservationsTool(name, args, { store, sessionId, surface }) {
  const session = store.mutable(sessionId)
  const guards = loadGuards(session.domain)
  const { db, identity } = session

  const gate = checkPreconditions(guards, name, session)
  if (!gate.ok) {
    store.appendAudit(sessionId, {
      tool: name,
      surface,
      ok: false,
      summary: gate.message,
      warning: `${name} 缺前置条件：${gate.missing.join('、')}`,
    })
    return toolResult(gate.message, session, false,
      { blocked: 'precondition', missing: gate.missing })
  }

  if (name === 'list_reservations') {
    const mine = db.reservations.filter(item => item.userId === identity.userId)
    if (!mine.length) {
      const content = '这位客户名下没有预订记录。'
      store.appendAudit(sessionId, { tool: name, surface, ok: true, summary: content })
      return toolResult(content, session, false, { count: 0 })
    }
    // 语音里念不了长列表。裁到三条并告知总数 —— 让模型有话可说
    // （「还有两笔，要听吗」），而不是自己决定念几个。
    const { shown, rest } = truncateForVoice(mine)
    const lines = shown.map(item => {
      const first = item.segments[0]
      const { flight } = flightOf(db, first.flightNo, first.date)
      const route = flight ? `${flight.from} → ${flight.to}` : first.flightNo
      return `${item.reservationId}　${route}　${first.date}`
        + `　${CABIN_TEXT[item.cabin] || item.cabin}　￥${item.total.toFixed(2)}`
    })
    const content = rest
      ? `${lines.join('\n')}\n还有 ${rest} 笔，共 ${mine.length} 笔。`
      : lines.join('\n')
    store.appendAudit(sessionId, {
      tool: name,
      surface,
      ok: true,
      summary: `列出 ${mine.length} 笔预订`,
    })
    return toolResult(content, session, false, { count: mine.length })
  }

  if (name === 'get_reservation') {
    const reservationId = clean(args.reservationId).toUpperCase()
    if (!reservationId) {
      const content = '需要预订编号才能查。请向客户索要，形如 CYR8801。'
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, {})
    }
    // 【只在本人名下找】拿到别人的订单号也查不出来 ——
    // 细则第十一条第一项：不得透露其他客户的任何信息。
    // 这一条在工具里硬拦，不靠 prompt。
    const reservation = db.reservations.find(item => (
      item.reservationId.toUpperCase() === reservationId
      && item.userId === identity.userId
    ))
    if (!reservation) {
      const content = '在这位客户名下没有找到这笔预订，请确认编号。'
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, { found: false })
    }

    const user = db.users.find(item => item.userId === reservation.userId)
    const allowance = decide(guards, 'free_baggage_allowance', {
      memberTier: user?.memberTier,
      cabin: reservation.cabin,
    })
    const flown = hasFlownSegment(db, reservation)

    const content = [
      `${reservation.reservationId}　${CABIN_TEXT[reservation.cabin] || reservation.cabin}`
      + `　￥${reservation.total.toFixed(2)}`,
      describeSegments(db, reservation),
      `　乘客：${reservation.passengers.map(item => item.name).join('、')}`,
      `　托运行李：已订 ${reservation.checkedBags} 件`
      + (allowance.available ? `，免费额度 ${allowance.outcome} 件`
        + `（${TIER_TEXT[user?.memberTier] || user?.memberTier}）` : ''),
      `　旅行保险：${reservation.insurance ? '已购买' : '未购买'}`,
      // 【已飞要显式说出来】它决定能不能改签、改舱位、退票三件事，
      // 而模型看不到 flight.status，只能靠这一行知道。
      flown ? '　注意：本预订已有航段执飞完毕。' : '',
    ].filter(Boolean).join('\n')

    store.appendAudit(sessionId, {
      tool: name,
      surface,
      ok: true,
      summary: `查看 ${reservation.reservationId}`,
    })
    return toolResult(content, session, false, {
      found: true,
      cabin: reservation.cabin,
      hasFlownSegment: flown,
    })
  }

  if (name === 'get_flight_status') {
    const flightNo = clean(args.flightNo).toUpperCase()
    const date = clean(args.date)
    if (!flightNo) {
      const content = '需要航班号才能查，形如 CY1201。'
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, {})
    }
    const found = flightOf(db, flightNo, date)
    if (found.ambiguous) {
      // 不猜哪一天 —— 让模型回去问客户。
      const days = found.ambiguous.map(item => item.date).join('、')
      const content = `${flightNo} 在 ${days} 都有航班，请向客户确认是哪一天。`
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, { ambiguous: true })
    }
    if (!found.flight) {
      const content = `查不到航班 ${flightNo}${date ? ` ${date}` : ''}。请确认航班号和日期。`
      store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
      return toolResult(content, session, false, { found: false })
    }

    const flight = found.flight
    const delay = flight.status === 'delayed' && flight.delayHours
      ? `　延误 ${flight.delayHours} 小时`
      : ''
    const content = `${flight.flightNo}　${flight.from} → ${flight.to}　${flight.date}`
      + `　${flight.departure}-${flight.arrival}`
      + `　${FLIGHT_STATUS_TEXT[flight.status] || flight.status}${delay}`
    store.appendAudit(sessionId, {
      tool: name,
      surface,
      ok: true,
      summary: `${flight.flightNo} ${FLIGHT_STATUS_TEXT[flight.status] || flight.status}`,
    })
    // 【不在这里算补偿】延误时长交回去，让模型按细则的档位表确认。
    // 在只读工具里顺手算出「该赔 400」等于把判定藏进查询，
    // 而那条判定是 guards 里的 delay_compensation 表要管的事。
    return toolResult(content, session, false, {
      found: true,
      status: flight.status,
      delayHours: flight.delayHours || 0,
    })
  }

  if (name === 'cancel_reservation') {
    const reservationId = clean(args.reservationId).toUpperCase()
    const reason = clean(args.reason)
    const token = clean(args.approval_token)

    const reservation = db.reservations.find(item => (
      item.reservationId.toUpperCase() === reservationId
      && item.userId === identity.userId
    ))
    if (!reservation) {
      return finish(store, sessionId, surface, name,
        '在这位客户名下没有找到这笔预订，请确认编号。', false, { found: false }, null, null)
    }
    if (reservation.status === 'cancelled') {
      return finish(store, sessionId, surface, name,
        '这笔预订已经退过票了。', false, { blocked: 'already_cancelled' }, null, null)
    }

    const user = db.users.find(item => item.userId === reservation.userId)

    // 【五个输入一起交给决策表，顺序由表定】
    // 表里的排序是有意的：已飞 > 航司取消 > 24 小时 > 公务舱 > 保险。
    // 排错就会把「公务舱已飞」判成全额退款。这一点在 airline.test.mjs
    // 里逐条断言过，所以这里只管把输入取对。
    const verdict = decide(guards, 'refundable', {
      hasFlownSegment: String(hasFlownSegment(db, reservation)),
      flightStatus: cancelledByAirline(db, reservation) ? 'cancelled' : 'scheduled',
      hoursSinceBooking: hoursSince(reservation.bookedAt),
      cabin: reservation.cabin,
      hasInsurance: String(Boolean(reservation.insurance)),
    })

    if (!verdict.available) {
      return finish(store, sessionId, surface, name,
        '退票资格判定没有配置，不能自行决定。请向客户说明需要人工确认，然后调用 transfer_to_human。',
        false, { blocked: 'no_decision_table' }, null, '缺 refundable 决策表')
    }
    if (verdict.outcome !== 'full_refund') {
      return finish(store, sessionId, surface, name,
        `这笔预订不能退款：${verdict.reason || '不符合退款条件'}。`,
        false, { blocked: 'not_refundable' }, null, null)
    }

    // 【表只看「有没有买保险」，原因要另外校验】
    // 细则第六条是「购买了旅行保险，且因健康或天气原因」——
    // 决策表的那一行没法表达「且」后面这半句，因为原因不是数据库字段，
    // 是客户说的话。所以拆成两处：表管情形，枚举管原因。
    //
    // 只在「靠保险才退得成」时才卡原因：公务舱、24 小时内、航司取消
    // 这三条本来就能全额退，不该因为客户说不清原因而拦住。
    const viaInsurance = verdict.reason?.includes('保险')
    if (viaInsurance) {
      const allowed = enumValues(guards, 'insurance_refund_reason')
      if (allowed && !allowed.includes(reason)) {
        return finish(store, sessionId, surface, name,
          `走旅行保险全额退款时，原因只能是${allowed.map(item => `「${item}」`).join('或')}。`
          + '请向客户确认具体是哪一种，细则只认这两类。',
          false, { blocked: 'insurance_reason' }, null, null)
      }
    }

    // 【超上限的不发令牌】没有令牌就执行不了，所以这条上限是拦截而非提示。
    const authority = decide(guards, 'refund_authority', { amount: reservation.total })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `退款金额 ￥${reservation.total.toFixed(2)} ${authority.reason || '超出客服权限'}，`
        + '客服不能自行处理。请向客户说明需要主管审批，然后调用 transfer_to_human。',
        false, { blocked: 'over_ceiling', total: reservation.total },
        `退款 ￥${reservation.total.toFixed(2)} 超上限，需转人工`, null)
    }

    if (!token) {
      const route = describeSegments(db, reservation)
        .split('\n')[0]
        .replace(/^\s*·\s*/, '')
      const preview = `将为预订 ${reservation.reservationId} 办理退票：${route}，`
        + `${refundNarrative(user, reservation, reservation.total)}。`
        + `依据：${verdict.reason || '符合退款条件'}。`
      const created = createApproval(session, {
        action: 'cancel_reservation',
        subject: reservation.reservationId,
        preview,
        effect: { reason, amount: reservation.total },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true },
        `退票 ${reservation.reservationId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'cancel_reservation', subject: reservation.reservationId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    reservation.status = 'cancelled'
    reservation.cancelledAt = new Date().toISOString()
    reservation.cancelReason = consumed.effect.reason || null
    reservation.payment.transactions.push({ type: 'refund', amount: consumed.effect.amount })
    const method = user?.paymentMethods?.find(item => item.id === reservation.payment.methodId)
    if (method?.type === 'gift_card') {
      // 礼品卡即时到账 —— 余额当场加回去，客户能立刻查到。
      method.balance = Math.round((method.balance + consumed.effect.amount) * 100) / 100
    }
    store.bumpVersion(sessionId)

    return finish(store, sessionId, surface, name,
      `预订 ${reservation.reservationId} 已退票，`
      + `${refundNarrative(user, reservation, consumed.effect.amount)}。`,
      true, { cancelled: true, amount: consumed.effect.amount },
      `退票 ${reservation.reservationId} ￥${consumed.effect.amount.toFixed(2)}`, null)
  }

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

  throw new Error(`Unknown reservations action: ${name}`)
}

// 统一出口：写审计、按需 bumpVersion、返回 toolResult。
// 和 returns/execute.mjs 里那个同名函数形态一致 —— 两个域的写库工具
// 都要「每次调用都留一条审计」，包括被拦下的那些。
function finish(store, sessionId, surface, tool, content, changed, data, summary, warning) {
  store.appendAudit(sessionId, {
    tool,
    surface,
    ok: changed || !data?.blocked,
    summary: summary || content.slice(0, 120),
    warning: warning || null,
  })
  return toolResult(content, store.mutable(sessionId), changed, data || {})
}
