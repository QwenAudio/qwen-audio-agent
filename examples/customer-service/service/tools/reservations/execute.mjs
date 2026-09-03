import { clean, toolResult, truncateForVoice } from '../shared.mjs'
import { checkPreconditions, decide, loadGuards } from '../../guards.mjs'

// 航空域的只读工具。写库类（改签、退票、加行李、发补偿）在下一批，
// 它们要走后台的 auth_required 批准链，形态和 returns/execute.mjs 一样。
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

  throw new Error(`Unknown reservations action: ${name}`)
}
