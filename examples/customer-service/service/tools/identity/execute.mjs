import { clean, toolResult } from '../shared.mjs'

// 核验是所有流程的前置门，所以它在前端面 —— 延迟直接影响体验。
// 它是只读的（查库里有没有这个人），写入的只有会话级的 identity 标记。

function findByEmail(db, email) {
  const needle = email.toLowerCase()
  // 空邮箱不能参与匹配：库里有刻意留空 email 的用户（陈静），
  // 若拿空串去比，任何没填邮箱的请求都会命中她。
  return db.users.find(user => user.email && user.email.toLowerCase() === needle) || null
}

function findByNameZip(db, name, zip) {
  return db.users.find(user => user.name === name && user.zip === zip) || null
}

export function executeIdentityTool(name, args, { store, sessionId, surface }) {
  const session = store.mutable(sessionId)

  if (name === 'identity_status') {
    const { identity } = session
    const content = identity.verified
      ? `已核验：${session.db.users.find(u => u.userId === identity.userId)?.name || identity.userId}`
        + `（方式：${identity.method === 'email' ? '邮箱' : '姓名+邮编'}）`
      : '尚未核验身份。'
    store.appendAudit(sessionId, { tool: name, surface, ok: true, summary: content })
    return toolResult(content, session, false, { verified: identity.verified })
  }

  if (name !== 'verify_identity') throw new Error(`Unknown identity action: ${name}`)

  const email = clean(args.email)
  const person = clean(args.name)
  const zip = clean(args.zip)

  // 参数缺失要给出【下一步该问什么】，而不是只说「参数错误」。
  // 模型拿到「请索要邮箱，或者姓名和邮编」会去问客户；
  // 拿到「invalid arguments」则可能反复重试同一个空调用。
  if (!email && !(person && zip)) {
    const content = person || zip
      ? '姓名和邮编需要同时提供，请把缺的那一项问清楚。'
      : '核验需要客户的注册邮箱，或者姓名加收货地址邮编，二者取其一。'
    store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
    return toolResult(content, session, false, { verified: false })
  }

  const matched = email
    ? findByEmail(session.db, email)
    : findByNameZip(session.db, person, zip)

  if (!matched) {
    // 【不泄露哪一项对不上】说「邮箱不存在」等于确认了「这个邮箱没注册过」，
    // 而未核验的来电者不该获得任何账户存在性信息。细则第十条。
    const content = email
      ? '这个邮箱没有匹配到账户。可以换姓名加邮编再试一次。'
      : '姓名和邮编没有匹配到账户。请确认后再试，或者用注册邮箱核验。'
    store.appendAudit(sessionId, {
      tool: name, surface, ok: false, summary: content,
    })
    return toolResult(content, session, false, { verified: false })
  }

  store.markVerified(sessionId, { userId: matched.userId, method: email ? 'email' : 'name_zip' })
  const content = `身份核验通过：${matched.name}。可以继续办理业务了。`
  store.appendAudit(sessionId, {
    tool: name, surface, ok: true,
    summary: `核验通过 ${matched.name}（${email ? '邮箱' : '姓名+邮编'}）`,
  })
  return toolResult(content, store.mutable(sessionId), true, {
    verified: true,
    customerName: matched.name,
  })
}
