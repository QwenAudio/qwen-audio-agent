import { clean, toolResult, truncateForVoice } from '../shared.mjs'
import { checkPreconditions, decide, enumValues, loadGuards, threshold } from '../../guards.mjs'
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

// 差价的方向不同，说法也不同。补差价客户要付钱，退差价按支付方式说到账时间。
// 【不要用字符串替换拼话术】第一版写成对 refundNarrative 的结果做两次
// replace，绕且看不出输出长什么样。直接分支写清楚。
function differenceNarrative(user, reservation, diff) {
  if (Math.abs(diff) < 0.01) return '票价相同，无需补差价'
  if (diff > 0) return `需补差价 ￥${diff.toFixed(2)}`
  const method = user?.paymentMethods?.find(item => item.id === reservation.payment.methodId)
  const channel = !method ? '原支付方式'
    : method.type === 'gift_card' ? '礼品卡（即时到账）'
      : `${method.brand}信用卡（3 到 7 个工作日到账）`
  return `将退差价 ￥${(-diff).toFixed(2)} 到${channel}`
}

// 五个写库工具都要「按 id 取本人名下的预订，取不到就给出统一话术」。
// 【只在本人名下找】拿到别人的订单号也查不出来 —— 细则第十一条。
function locate(db, identity, rawId) {
  const reservationId = String(rawId || '').trim().toUpperCase()
  if (!reservationId) {
    return { error: '需要预订编号才能办理，请向客户索要，形如 CYR8801。' }
  }
  const reservation = db.reservations.find(item => (
    item.reservationId.toUpperCase() === reservationId
    && item.userId === identity.userId
  ))
  if (!reservation) {
    return { error: '在这位客户名下没有找到这笔预订，请确认编号。' }
  }
  if (reservation.status === 'cancelled') {
    return { error: '这笔预订已经退票，不能再办理变更。' }
  }
  return { reservation, user: db.users.find(item => item.userId === reservation.userId) }
}

// 一笔预订的票面总价（不含保险）。改签与改舱位算差价都要用它。
function fareOf(db, reservation, cabin = reservation.cabin) {
  return reservation.segments.reduce((sum, segment) => {
    const { flight } = flightOf(db, segment.flightNo, segment.date)
    return sum + (flight?.prices?.[cabin] ?? 0)
  }, 0)
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

  if (name === 'search_flights') {
    const from = clean(args.from).toUpperCase()
    const to = clean(args.to).toUpperCase()
    const cabin = clean(args.cabin)
    const date = clean(args.date)
    if (!from || !to || !cabin) {
      return finish(store, sessionId, surface, name,
        '搜航班要给出发地、目的地和舱位三项。改签不能改出发地和目的地，'
        + '所以填原航段的那两个。', false, {}, null, null)
    }
    const options = db.flights.filter(flight => (
      flight.from === from
      && flight.to === to
      && (!date || flight.date === date)
      // 【只返回还有余量的】列出满舱的航班等于让客户白选一次
      && (flight.seats?.[cabin] ?? 0) > 0
      // 已飞和已取消的不能作为改签目标
      && flight.status !== 'flown'
      && flight.status !== 'cancelled'
    ))
    if (!options.length) {
      return finish(store, sessionId, surface, name,
        `${from} 到 ${to}${date ? ` ${date}` : ''} 没有${CABIN_TEXT[cabin] || cabin}的可订航班。`
        + '可以问客户是否接受别的日期。', false, { count: 0 }, null, null)
    }
    const { shown, rest } = truncateForVoice(options)
    const lines = shown.map(flight => (
      `${flight.flightNo}　${flight.date} ${flight.departure}-${flight.arrival}`
      + `　￥${flight.prices[cabin].toFixed(2)}　余 ${flight.seats[cabin]} 座`
    ))
    const content = rest
      ? `${lines.join('\n')}\n还有 ${rest} 班，共 ${options.length} 班。`
      : lines.join('\n')
    return finish(store, sessionId, surface, name, content, false,
      { count: options.length }, `搜到 ${options.length} 班 ${from}-${to}`, null)
  }

  if (name === 'update_baggages') {
    const located = locate(db, identity, args.reservationId)
    if (located.error) {
      return finish(store, sessionId, surface, name, located.error, false, {}, null, null)
    }
    const { reservation, user } = located
    const token = clean(args.approval_token)
    const totalBags = Number(args.totalBags)

    if (!Number.isInteger(totalBags) || totalBags < 0) {
      return finish(store, sessionId, surface, name,
        '行李件数要给一个整数，而且是【改完之后的总件数】，不是新增件数。',
        false, {}, null, null)
    }
    // 【行李只能增不能减】细则第五条。传更小的数不是「参数错误」，
    // 是业务上不允许 —— 话术要让模型能向客户解释，而不是重试。
    if (totalBags <= reservation.checkedBags) {
      return finish(store, sessionId, surface, name,
        `当前已订 ${reservation.checkedBags} 件，行李只能增加不能减少。`
        + '请向客户说明这条规则。', false, { blocked: 'baggage_decrease' }, null, null)
    }

    const allowance = decide(guards, 'free_baggage_allowance', {
      memberTier: user?.memberTier,
      cabin: reservation.cabin,
    })
    if (!allowance.available) {
      return finish(store, sessionId, surface, name,
        '免费行李额度表没有配置，不能自行判断。请转人工确认。',
        false, { blocked: 'no_decision_table' }, null, '缺 free_baggage_allowance 表')
    }
    // 【未覆盖的会员等级与舱位组合走兜底行】兜底给 0 件并带 reason。
    // 那时不该自行收费 —— 转人工。
    if (allowance.viaCatchAll) {
      return finish(store, sessionId, surface, name,
        `${allowance.reason || '细则里没有规定这个会员等级与舱位的免费额度'}。`
        + '请向客户说明需要人工确认，然后调用 transfer_to_human。',
        false, { blocked: 'policy_gap' }, null, null)
    }

    const free = allowance.outcome
    const perBag = threshold(guards, 'extra_baggage_fee', 0)
    const billable = Math.max(0, totalBags - free)
    const fee = Math.round(billable * perBag * 100) / 100

    if (!token) {
      const preview = `将把预订 ${reservation.reservationId} 的托运行李从 `
        + `${reservation.checkedBags} 件改为 ${totalBags} 件。`
        + `${TIER_TEXT[user?.memberTier] || ''}${CABIN_TEXT[reservation.cabin] || ''}`
        + `免费额度 ${free} 件，`
        + (fee > 0
          ? `超出 ${billable} 件，需付 ￥${fee.toFixed(2)}。`
          : '未超出免费额度，不额外收费。')
      const created = createApproval(session, {
        action: 'update_baggages',
        subject: reservation.reservationId,
        preview,
        effect: { totalBags, fee },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true, fee },
        `加行李 ${reservation.reservationId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'update_baggages', subject: reservation.reservationId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    reservation.checkedBags = consumed.effect.totalBags
    if (consumed.effect.fee > 0) {
      reservation.total = Math.round((reservation.total + consumed.effect.fee) * 100) / 100
      reservation.payment.transactions.push({ type: 'payment', amount: consumed.effect.fee })
    }
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `已把托运行李改为 ${consumed.effect.totalBags} 件`
      + (consumed.effect.fee > 0 ? `，收取 ￥${consumed.effect.fee.toFixed(2)}。` : '。'),
      true, { totalBags: consumed.effect.totalBags, fee: consumed.effect.fee },
      `${reservation.reservationId} 行李改为 ${consumed.effect.totalBags} 件`, null)
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

  if (name === 'update_flights') {
    const located = locate(db, identity, args.reservationId)
    if (located.error) {
      return finish(store, sessionId, surface, name, located.error, false, {}, null, null)
    }
    const { reservation, user } = located
    const token = clean(args.approval_token)
    const flightNo = clean(args.flightNo).toUpperCase()
    const date = clean(args.date)

    // 改签资格：特价经济舱不可改，已飞不可改。两条都在表里。
    const changeable = decide(guards, 'changeable', {
      cabin: reservation.cabin,
      hasFlownSegment: String(hasFlownSegment(db, reservation)),
    })
    if (changeable.outcome !== 'allow') {
      return finish(store, sessionId, surface, name,
        `这笔预订不能改签：${changeable.reason || '不符合改签条件'}。`,
        false, { blocked: 'not_changeable' }, null, null)
    }

    // 【单航段才支持改签】多航段要改哪一段、其余段怎么算，
    // 细则没写。不猜 —— 转人工。
    if (reservation.segments.length !== 1) {
      return finish(store, sessionId, surface, name,
        '这笔预订有多个航段，细则里没有规定多航段改签怎么处理。'
        + '请向客户说明需要人工确认，然后调用 transfer_to_human。',
        false, { blocked: 'policy_gap' }, null, null)
    }

    const current = flightOf(db, reservation.segments[0].flightNo, reservation.segments[0].date).flight
    const target = flightOf(db, flightNo, date)
    if (target.ambiguous) {
      const days = target.ambiguous.map(item => item.date).join('、')
      return finish(store, sessionId, surface, name,
        `${flightNo} 在 ${days} 都有航班，请向客户确认改到哪一天。`,
        false, { ambiguous: true }, null, null)
    }
    if (!target.flight) {
      return finish(store, sessionId, surface, name,
        `查不到航班 ${flightNo}${date ? ` ${date}` : ''}，请确认航班号和日期。`,
        false, { found: false }, null, null)
    }
    const next = target.flight

    // 【不能改出发地、目的地】细则第三条。这一条不在决策表里 ——
    // 它不是「可调的业务参数」，是改签这个动作的定义。
    if (next.from !== current.from || next.to !== current.to) {
      return finish(store, sessionId, surface, name,
        `改签不能改变航线。原航段是 ${current.from} 到 ${current.to}，`
        + `${next.flightNo} 是 ${next.from} 到 ${next.to}。`,
        false, { blocked: 'route_changed' }, null, null)
    }
    if (next.flightNo === current.flightNo && next.date === current.date) {
      return finish(store, sessionId, surface, name,
        '这就是当前的航班，不需要改签。', false, { blocked: 'same_flight' }, null, null)
    }
    if ((next.seats?.[reservation.cabin] ?? 0) <= 0) {
      return finish(store, sessionId, surface, name,
        `${next.flightNo} 的${CABIN_TEXT[reservation.cabin]}已经没有余量了。`
        + '可以用 search_flights 看别的航班。',
        false, { blocked: 'no_seat' }, null, null)
    }

    const feeVerdict = decide(guards, 'change_fee', { cabin: reservation.cabin })
    const fee = typeof feeVerdict.outcome === 'number' && feeVerdict.outcome >= 0
      ? feeVerdict.outcome
      : 0
    const diff = Math.round(
      (next.prices[reservation.cabin] - current.prices[reservation.cabin]) * 100,
    ) / 100
    const payable = Math.round((fee + Math.max(diff, 0)) * 100) / 100

    // 涉款要过权限上限：手续费加补的差价合起来算。
    const authority = decide(guards, 'refund_authority', {
      amount: Math.max(payable, -diff),
    })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `这笔改签涉及金额 ${authority.reason || '超出客服权限'}，不能自行处理。`
        + '请向客户说明需要主管审批，然后调用 transfer_to_human。',
        false, { blocked: 'over_ceiling' }, null, `改签金额超上限，需转人工`)
    }

    if (!token) {
      const preview = `将把预订 ${reservation.reservationId} 从 `
        + `${current.flightNo}（${current.date} ${current.departure}）改到 `
        + `${next.flightNo}（${next.date} ${next.departure}）。`
        + `${CABIN_TEXT[reservation.cabin]}改签手续费 ￥${fee.toFixed(2)}，`
        + `${differenceNarrative(user, reservation, diff)}。`
      const created = createApproval(session, {
        action: 'update_flights',
        subject: reservation.reservationId,
        preview,
        effect: { flightNo: next.flightNo, date: next.date, fee, diff },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true, fee, diff },
        `改签 ${reservation.reservationId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'update_flights', subject: reservation.reservationId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    // 余量：老航班加回去，新航班减掉。
    current.seats[reservation.cabin] += 1
    next.seats[reservation.cabin] -= 1
    reservation.segments[0] = { flightNo: consumed.effect.flightNo, date: consumed.effect.date }
    const delta = Math.round((consumed.effect.fee + consumed.effect.diff) * 100) / 100
    reservation.total = Math.round((reservation.total + delta) * 100) / 100
    reservation.payment.transactions.push({
      type: delta >= 0 ? 'payment' : 'refund',
      amount: Math.abs(delta),
    })
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `已改签到 ${consumed.effect.flightNo}（${consumed.effect.date}）。`
      + (delta > 0 ? `共收取 ￥${delta.toFixed(2)}。`
        : delta < 0 ? `退回 ￥${Math.abs(delta).toFixed(2)}。` : '无需补款。'),
      true, { changed: true, flightNo: consumed.effect.flightNo },
      `改签 ${reservation.reservationId} → ${consumed.effect.flightNo}`, null)
  }

  if (name === 'update_cabin') {
    const located = locate(db, identity, args.reservationId)
    if (located.error) {
      return finish(store, sessionId, surface, name, located.error, false, {}, null, null)
    }
    const { reservation, user } = located
    const token = clean(args.approval_token)
    const cabin = clean(args.cabin)

    const allowedCabins = enumValues(guards, 'cabin')
    if (allowedCabins && !allowedCabins.includes(cabin)) {
      return finish(store, sessionId, surface, name,
        `舱位只能是${allowedCabins.map(item => `${CABIN_TEXT[item] || item}`).join('、')}。`,
        false, {}, null, null)
    }
    if (cabin === reservation.cabin) {
      return finish(store, sessionId, surface, name,
        `这笔预订已经是${CABIN_TEXT[cabin]}了。`, false, { blocked: 'same_cabin' }, null, null)
    }

    // 【改舱位比改签宽松】所有舱位都能改，包括特价经济舱 ——
    // 只有已飞航段例外。这一点和 changeable 表刻意分成两张表。
    const editable = decide(guards, 'cabin_changeable', {
      hasFlownSegment: String(hasFlownSegment(db, reservation)),
    })
    if (editable.outcome !== 'allow') {
      return finish(store, sessionId, surface, name,
        `这笔预订不能改舱位：${editable.reason || '不符合条件'}。`,
        false, { blocked: 'not_editable' }, null, null)
    }

    // 目标舱位每一段都要有余量 —— 同一预订内舱位必须一致，
    // 有一段没位子整笔就改不了。
    const shortage = reservation.segments.find(segment => {
      const { flight } = flightOf(db, segment.flightNo, segment.date)
      return (flight?.seats?.[cabin] ?? 0) <= 0
    })
    if (shortage) {
      return finish(store, sessionId, surface, name,
        `${shortage.flightNo} 的${CABIN_TEXT[cabin]}没有余量，`
        + '而同一预订内所有航段的舱位必须一致，所以这笔改不了。',
        false, { blocked: 'no_seat' }, null, null)
    }

    const diff = Math.round(
      (fareOf(db, reservation, cabin) - fareOf(db, reservation)) * 100,
    ) / 100
    const authority = decide(guards, 'refund_authority', { amount: Math.abs(diff) })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `差价 ￥${Math.abs(diff).toFixed(2)} ${authority.reason || '超出客服权限'}，`
        + '不能自行处理。请向客户说明需要主管审批，然后调用 transfer_to_human。',
        false, { blocked: 'over_ceiling' }, null, '改舱位差价超上限，需转人工')
    }

    if (!token) {
      const preview = `将把预订 ${reservation.reservationId} 从`
        + `${CABIN_TEXT[reservation.cabin]}改为${CABIN_TEXT[cabin]}，航班不变。`
        + `${differenceNarrative(user, reservation, diff)}。`
      const created = createApproval(session, {
        action: 'update_cabin',
        subject: reservation.reservationId,
        preview,
        effect: { cabin, diff },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true, diff },
        `改舱位 ${reservation.reservationId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'update_cabin', subject: reservation.reservationId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    const from = reservation.cabin
    for (const segment of reservation.segments) {
      const { flight } = flightOf(db, segment.flightNo, segment.date)
      if (!flight) continue
      flight.seats[from] += 1
      flight.seats[consumed.effect.cabin] -= 1
    }
    reservation.cabin = consumed.effect.cabin
    reservation.total = Math.round((reservation.total + consumed.effect.diff) * 100) / 100
    reservation.payment.transactions.push({
      type: consumed.effect.diff >= 0 ? 'payment' : 'refund',
      amount: Math.abs(consumed.effect.diff),
    })
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `已改为${CABIN_TEXT[consumed.effect.cabin]}。`
      + (consumed.effect.diff > 0 ? `收取差价 ￥${consumed.effect.diff.toFixed(2)}。`
        : consumed.effect.diff < 0 ? `退回差价 ￥${Math.abs(consumed.effect.diff).toFixed(2)}。`
          : '票价相同。'),
      true, { cabin: consumed.effect.cabin, diff: consumed.effect.diff },
      `${reservation.reservationId} 改为${CABIN_TEXT[consumed.effect.cabin]}`, null)
  }

  if (name === 'send_certificate') {
    const located = locate(db, identity, args.reservationId)
    if (located.error) {
      return finish(store, sessionId, surface, name, located.error, false, {}, null, null)
    }
    const { reservation } = located
    const token = clean(args.approval_token)

    // 【同一预订只能发一次】细则第七条。这个状态记在预订上 ——
    // 靠模型记住「刚才发过了」是守不住的，尤其在长通话里。
    if (reservation.certificateIssued) {
      return finish(store, sessionId, surface, name,
        `这笔预订已经发过延误补偿了`
        + `（￥${reservation.certificateIssued.amount}，`
        + `${String(reservation.certificateIssued.at).slice(0, 10)}）。`
        + '细则规定同一预订只能发一次。',
        false, { blocked: 'already_issued' }, null, null)
    }

    // 取这笔预订里延误最久的那一段 —— 补偿按最严重的算。
    const worst = reservation.segments.reduce((max, segment) => {
      const { flight } = flightOf(db, segment.flightNo, segment.date)
      const hours = flight?.status === 'delayed' ? (flight.delayHours || 0) : 0
      return hours > max ? hours : max
    }, 0)

    const verdict = decide(guards, 'delay_compensation', { delayHours: worst })
    if (!verdict.available) {
      return finish(store, sessionId, surface, name,
        '延误补偿标准没有配置，不能自行决定金额。请转人工确认。',
        false, { blocked: 'no_decision_table' }, null, '缺 delay_compensation 表')
    }
    const amount = Number(verdict.outcome) || 0
    if (amount <= 0) {
      return finish(store, sessionId, surface, name,
        worst > 0
          ? `延误 ${worst} 小时，${verdict.reason || '不足补偿门槛'}。`
          : '这笔预订的航班没有延误记录，没有补偿。',
        false, { blocked: 'no_compensation', delayHours: worst }, null, null)
    }

    const authority = decide(guards, 'refund_authority', { amount })
    if (authority.outcome === 'escalate') {
      return finish(store, sessionId, surface, name,
        `补偿金额 ￥${amount.toFixed(2)} ${authority.reason || '超出客服权限'}，`
        + '不能自行发放。请转人工主管。',
        false, { blocked: 'over_ceiling' }, null, '补偿金额超上限，需转人工')
    }

    if (!token) {
      const preview = `将为预订 ${reservation.reservationId} 发放 ￥${amount.toFixed(2)} 旅行券，`
        + `依据是航班延误 ${worst} 小时。旅行券余额不可退现，同一预订只能发一次。`
      const created = createApproval(session, {
        action: 'send_certificate',
        subject: reservation.reservationId,
        preview,
        effect: { amount, delayHours: worst },
      })
      return finish(store, sessionId, surface, name,
        approvalPrompt(created.preview, created.token), false,
        { needsApproval: true, amount },
        `发补偿 ${reservation.reservationId} 待客户批准`, null)
    }

    const consumed = consumeApproval(session, {
      action: 'send_certificate', subject: reservation.reservationId, token,
    })
    if (consumed.error) {
      return finish(store, sessionId, surface, name,
        APPROVAL_ERROR_TEXT[consumed.error], false,
        { approvalError: consumed.error }, null, `批准令牌校验失败：${consumed.error}`)
    }

    reservation.certificateIssued = {
      amount: consumed.effect.amount,
      delayHours: consumed.effect.delayHours,
      at: new Date().toISOString(),
    }
    store.bumpVersion(sessionId)
    return finish(store, sessionId, surface, name,
      `已发放 ￥${consumed.effect.amount.toFixed(2)} 旅行券，`
      + `依据航班延误 ${consumed.effect.delayHours} 小时。余额不可退现。`,
      true, { amount: consumed.effect.amount },
      `${reservation.reservationId} 发补偿 ￥${consumed.effect.amount}`, null)
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
