import { clean, toolResult } from '../shared.mjs'

// 核验是所有流程的前置门，所以它在前端面 —— 延迟直接影响体验。
// 它是只读的（查库里有没有这个人），写入的只有会话级的 identity 标记。
//
// 【为什么按域分支而不是写两份工具】
// 两个域的核验判据不同：
//   零售  注册邮箱        或  姓名 + 收货地址邮编
//   航空  会员号          或  姓名 + 证件号后四位
// 但工具名必须保持 verify_identity 一个 —— 否则人设、前台白名单、
// guards.json 的 preconditions 全都要分域再写一遍，而那些本来是域无关的。
//
// 判据表放在这里而不是 guards.json：它不是「可以调的业务参数」，
// 是「这个域的账户长什么样」，属于数据模型的一部分。
// 管理员改 policy 改不动它，改的话得连 db.json 一起改。

const DOMAIN_RULES = Object.freeze({
  retail: {
    // 每种方式要哪些字段，缺了就提示补哪个
    methods: [
      { id: 'email', label: '邮箱', requires: ['email'] },
      { id: 'name_zip', label: '姓名+邮编', requires: ['name', 'zip'] },
    ],
    ask: '核验需要客户的注册邮箱，或者姓名加收货地址邮编，二者取其一。',
    askPartial: '姓名和邮编需要同时提供，请把缺的那一项问清楚。',
    match(db, args) {
      const email = clean(args.email)
      if (email) {
        const needle = email.toLowerCase()
        // 空邮箱不能参与匹配：库里有刻意留空 email 的用户（陈静），
        // 若拿空串去比，任何没填邮箱的请求都会命中她。
        const user = db.users.find(item => item.email && item.email.toLowerCase() === needle)
        return user ? { user, method: 'email' } : null
      }
      const name = clean(args.name)
      const zip = clean(args.zip)
      const user = db.users.find(item => item.name === name && item.zip === zip)
      return user ? { user, method: 'name_zip' } : null
    },
  },
  airline: {
    methods: [
      { id: 'member', label: '会员号', requires: ['memberId'] },
      { id: 'name_id', label: '姓名+证件后四位', requires: ['name', 'idTail'] },
    ],
    ask: '核验需要客户的会员号，或者姓名加证件号后四位，二者取其一。',
    askPartial: '姓名和证件号后四位需要同时提供，请把缺的那一项问清楚。',
    match(db, args) {
      const memberId = clean(args.memberId).toUpperCase()
      if (memberId) {
        const user = db.users.find(item => item.userId.toUpperCase() === memberId)
        return user ? { user, method: 'member' } : null
      }
      const name = clean(args.name)
      const idTail = clean(args.idTail)
      // 【证件后四位单独不能核验】细则第一条：姓名与证件号后四位「两项同时一致」。
      // 后四位的碰撞概率是万分之一，单独用它等于没核验。
      const user = db.users.find(item => item.name === name && item.idTail === idTail)
      return user ? { user, method: 'name_id' } : null
    },
  },
})

function rulesFor(domain) {
  const rules = DOMAIN_RULES[domain]
  if (!rules) throw new Error(`没有为域 ${domain} 定义身份核验判据`)
  return rules
}

// 哪些方式给了「一部分」参数 —— 用来区分「什么都没给」和「给了一半」。
// 这个区分对模型有用：前者要问「请提供 X 或 Y」，后者要问「还缺 Z」。
function partiallySupplied(rules, args) {
  return rules.methods.some(method => {
    const filled = method.requires.filter(key => clean(args[key]))
    return filled.length > 0 && filled.length < method.requires.length
  })
}

function methodLabel(rules, methodId) {
  return rules.methods.find(method => method.id === methodId)?.label || methodId
}

export function executeIdentityTool(name, args, { store, sessionId, surface }) {
  const session = store.mutable(sessionId)
  const rules = rulesFor(session.domain)

  if (name === 'identity_status') {
    const { identity } = session
    const person = session.db.users.find(user => user.userId === identity.userId)
    const content = identity.verified
      ? `已核验：${person?.name || identity.userId}（方式：${methodLabel(rules, identity.method)}）`
      : '尚未核验身份。'
    store.appendAudit(sessionId, { tool: name, surface, ok: true, summary: content })
    return toolResult(content, session, false, { verified: identity.verified })
  }

  if (name !== 'verify_identity') throw new Error(`Unknown identity action: ${name}`)

  const complete = rules.methods.some(
    method => method.requires.every(key => clean(args[key])),
  )

  // 参数缺失要给出【下一步该问什么】，而不是只说「参数错误」。
  // 模型拿到「请索要会员号，或者姓名和证件后四位」会去问客户；
  // 拿到「invalid arguments」则可能反复重试同一个空调用。
  if (!complete) {
    const content = partiallySupplied(rules, args) ? rules.askPartial : rules.ask
    store.appendAudit(sessionId, { tool: name, surface, ok: false, summary: content })
    return toolResult(content, session, false, { verified: false })
  }

  const matched = rules.match(session.db, args)

  if (!matched) {
    // 【不说「这个客户不存在」】那等于确认或否认账户是否存在，
    // 细则第十条明令禁止。只说这次没匹配上，让客户换一种方式再试。
    const content = '这次没能匹配到账户。可以换另一种方式再核验一次。'
    store.appendAudit(sessionId, {
      tool: name,
      surface,
      ok: false,
      summary: content,
      warning: null,
    })
    return toolResult(content, session, false, { verified: false })
  }

  store.markVerified(sessionId, { userId: matched.user.userId, method: matched.method })
  const content = `身份核验通过：${matched.user.name}。可以继续办理业务了。`
  store.appendAudit(sessionId, {
    tool: name,
    surface,
    ok: true,
    summary: `核验通过 ${matched.user.name}（${methodLabel(rules, matched.method)}）`,
  })
  return toolResult(content, store.mutable(sessionId), true, {
    verified: true,
    // 【两个都返回】customerName 给界面显示，userId 给后续工具做归属过滤。
    // 我改这个文件时一度只留了 userId，测试立刻抓到 —— 客户名字是
    // client 面板和审计摘要都在用的东西。
    customerName: matched.user.name,
    userId: matched.user.userId,
  })
}
