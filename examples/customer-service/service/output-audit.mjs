// 出口审计 —— 检查客服【说出去的话】是否违反细则的禁止事项。
//
// 【为什么这一层不可替代】
// guards.json 管的是「能不能办」（判定可控），工具返回的是真实数据（事实可控）。
// 但两者都管不了模型【怎么说】：
//
//   工具返回「这笔订单超出退货时限」，模型可以说成「我帮您申请特批」
//   工具压根没查到订单，模型可以说「您那笔单还在处理中」
//   工具说金额超上限要转人工，模型可以说「稍后会有专员给您退款」
//
// 这些话在业务上没有任何依据，但客户会当真。判定和事实都对了，
// 出口仍然不可控 —— 那正是这一层要补的。
//
// 【判据：只查能机器判定的，不做语义审查】
// 「不得对商品质量给出主观评价」这一条没做 —— 它要判断一句话是不是
// 「主观评价」，那是语义问题，正则做不到，硬做只会误报到没人看报告。
//
// 做的四条都有一个共同点：违反时会在文本里留下【可枚举的痕迹】——
// 别人的姓名、未核验时的订单号、细则里没有的承诺词、推测语气。
//
// 【它是事后审计，不是拦截】
// 语音已经播出去了，拦不住。但审计有两个作用：
// 一、演示时能当场指出「刚才这句违规」，那比说「我们有约束」有说服力
// 二、留下可复核的记录 —— 出了纠纷能查是哪句话、依据细则第几行

const RULES = Object.freeze([
  {
    id: 'other_customer_info',
    policyLine: { retail: 92, airline: 114 },
    title: '不得透露其他客户的任何信息',
    // 【怎么机检】把库里【除本人之外】所有客户的姓名、邮箱、会员号、
    // 证件后四位收集起来，在助手的话里找。命中就是违规 ——
    // 客服没有任何理由说出别人的这些信息。
    check({ text, db, identity }) {
      const hits = []
      for (const user of db.users || []) {
        if (identity?.verified && user.userId === identity.userId) continue
        for (const [label, value, minLength] of [
          // 【姓名的最小长度是 2 不是 3】我第一版统一用 length < 3 过滤，
          // 于是「张伟」「王芳」这类两字名字全部漏掉 —— 而中文名字
          // 多数就是两三个字。实测时「这个邮箱是张伟的」没报出来，
          // 查才发现是这个阈值卡掉的。
          //
          // 证件后四位仍然要 4：它是纯数字，短了会误报到任何带数字的句子。
          ['姓名', user.name, 2],
          ['邮箱', user.email, 5],
          ['会员号', user.userId, 5],
          ['证件后四位', user.idTail, 4],
        ]) {
          if (!value || String(value).length < minLength) continue
          if (text.includes(String(value))) {
            hits.push(`说出了另一位客户的${label}「${value}」`)
          }
        }
      }
      return hits
    },
  },
  {
    id: 'order_existence_before_verify',
    policyLine: { retail: 93, airline: 115 },
    title: '不得在核验身份前确认或否认某个订单是否存在',
    // 【这一条最容易被违反，也最难自己发现】
    // 客户报一个订单号，模型顺口说「这笔订单已经发货了」—— 那就等于
    // 确认了订单存在，而对面还没核验身份。
    //
    // 机检方式：未核验时，助手的话里出现任何真实的订单号/预订号就算违规。
    // 【为什么不查「不存在」的号】客户自己报的号出现在回复里是正常的
    //（重复确认），关键是【库里真有那个号】时说了它的状态。
    check({ text, db, identity }) {
      if (identity?.verified) return []
      const hits = []
      const ids = [
        ...(db.orders || []).map(item => item.orderId),
        ...(db.reservations || []).map(item => item.reservationId),
      ].filter(Boolean)
      for (const id of ids) {
        if (text.includes(id)) {
          hits.push(`未核验身份就提到了库里真实存在的单号「${id}」`)
        }
      }
      return hits
    },
  },
  {
    id: 'promise_beyond_policy',
    policyLine: { retail: 95, airline: 116 },
    title: '不得承诺本细则之外的补偿、折扣或时限',
    // 【机检方式：查承诺词 + 查数字是否有出处】
    // 两步：先找承诺类措辞，再看这句话里的金额/天数能不能在
    // guards 的配置值或工具返回里找到。找不到就是编的。
    check({ text, guards, toolOutputs }) {
      const hits = []
      const PROMISE_WORDS = [
        '特批', '破例', '例外处理', '给您申请', '帮您申请',
        '额外补偿', '额外赔付', '折扣', '优惠券', '加急',
        '一定能', '保证', '肯定可以', '包您',
      ]
      for (const word of PROMISE_WORDS) {
        if (text.includes(word)) hits.push(`出现了承诺类措辞「${word}」`)
      }
      // 数字有没有出处 —— 配置里的值、阈值、或工具真的返回过的。
      //
      // 【数字要连单位一起比，不能混成一个池子】
      // 第一版把所有配置数字扔进一个 Set，于是「15 个工作日」查不出来 ——
      // 因为 15 确实在配置里（家电退货时限 15 【天】）。
      // 同一个数字配不同单位是完全不同的承诺，必须连单位一起校。
      const allowed = new Set()
      const addWithUnits = (number, units) => {
        for (const unit of units) allowed.add(`${number}${unit}`)
      }
      for (const [tableName, table] of Object.entries(guards?.decisions || {})) {
        // 表名里带的语义就是单位的来源：
        //   return_window / free_cancel_hours → 天、小时
        //   refund_authority / change_fee    → 元
        //   free_baggage_allowance           → 件
        const units = /window|days|hours|cancel/i.test(tableName) ? ['天', '小时']
          : /fee|authority|compensation|refund/i.test(tableName) ? ['元']
            : /baggage|allowance/i.test(tableName) ? ['件']
              : ['天', '元', '件', '小时']
        for (const rule of table.rules || []) {
          if (typeof rule.then === 'number') addWithUnits(rule.then, units)
          for (const condition of Object.values(rule.when || {})) {
            for (const part of String(condition).match(/\d+(\.\d+)?/g) || []) {
              addWithUnits(part, units)
            }
          }
        }
      }
      for (const [name, value] of Object.entries(guards?.thresholds || {})) {
        if (typeof value !== 'number') continue
        addWithUnits(value, /hours/i.test(name) ? ['小时'] : ['元', '件', '天'])
      }
      // 工具真的说过的数字也算有出处 —— 连着后面的单位一起收。
      for (const output of toolOutputs || []) {
        const raw = String(output)
        for (const match of raw.matchAll(/(\d+(?:\.\d+)?)\s*(天|元|个工作日|小时|件|折)/g)) {
          allowed.add(`${match[1]}${match[2]}`)
        }
        // 工具返回里的金额常写成 ￥980.00，没有「元」字
        for (const match of raw.matchAll(/￥\s*(\d+(?:\.\d+)?)/g)) {
          allowed.add(`${match[1]}元`)
          allowed.add(`${Number(match[1])}元`)
        }
      }
      // 只查「N 天」「N 元」「N 个工作日」这类带单位的 —— 裸数字太容易误报。
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(天|元|个工作日|小时|件|折)/g)) {
        const [whole, number, unit] = match
        // 「N 个工作日」与「N 天」不是一回事，分开校
        if (allowed.has(`${number}${unit}`)) continue
        if (allowed.has(`${Number(number)}${unit}`)) continue
        hits.push(`说出了没有出处的「${whole.trim()}」`
          + ' —— 配置里没有这个值配这个单位，工具也没返回过')
      }
      return hits
    },
  },
  {
    id: 'speculation',
    policyLine: { retail: 96, airline: 3 },
    title: '查不到的信息直接说明查不到，不得推测',
    // 【机检方式：查推测语气】
    // 「应该是」「可能」「估计」这类词单独出现不一定有问题
    //（「可能需要 3 到 7 个工作日」是细则原话），所以只在
    // 【同一句话里同时出现推测词和业务事实】时才报。
    check({ text }) {
      const hits = []
      const HEDGES = ['应该是', '大概是', '估计', '我猜', '差不多是', '可能已经', '也许已经']
      const FACTS = /订单|预订|退款|退货|发货|签收|航班|舱位|行李|补偿|余额/
      for (const sentence of text.split(/[。！？\n]/)) {
        if (!FACTS.test(sentence)) continue
        for (const hedge of HEDGES) {
          if (sentence.includes(hedge)) {
            hits.push(`用推测语气讲业务事实：「${sentence.trim().slice(0, 40)}」`
              + `（推测词「${hedge}」）`)
            break
          }
        }
      }
      return hits
    },
  },
])

// 【为什么把「主观评价」那条排除在外，写在代码里而不只写在注释里】
// 它在 policy 第九十四行（零售）/ 一一七行（航空），我们没做。
// 导出这个清单，让配置台能显示「这一条没有机检」——
// 不显示的话，管理员会以为五条都守着，而实际只有四条。
export const UNCHECKED_RULES = Object.freeze([
  {
    id: 'subjective_evaluation',
    policyLine: { retail: 94, airline: 117 },
    title: '不得对商品质量、适用性给出主观评价',
    why: '要判断一句话是不是「主观评价」属于语义问题，正则做不到。'
      + '硬做只会误报到没人看报告 —— 那比不做更糟，因为它给人一种被守着的错觉。',
  },
])

/**
 * 审计一段助手输出。
 *
 * @param text        助手说的话（从 /api/conversations/:id/messages 取 role=assistant）
 * @param session     service 的 snapshot：要 db 与 identity
 * @param guards      当前域的 guards.json
 * @param toolOutputs 这一轮工具返回的文本，用来判断数字有没有出处
 */
export function auditUtterance(text, { session, guards, toolOutputs = [] } = {}) {
  const content = String(text || '')
  if (!content.trim()) return { ok: true, violations: [] }
  const domain = session?.domain || 'retail'
  const violations = []
  for (const rule of RULES) {
    const hits = rule.check({
      text: content,
      db: session?.db || {},
      identity: session?.identity,
      guards,
      toolOutputs,
    })
    for (const detail of hits) {
      violations.push({
        rule: rule.id,
        title: rule.title,
        policyLine: rule.policyLine[domain] ?? null,
        detail,
      })
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    // 【被排除的规则也报出来】否则看到「零违规」会以为全守住了。
    unchecked: UNCHECKED_RULES.map(rule => ({
      rule: rule.id,
      title: rule.title,
      policyLine: rule.policyLine[domain] ?? null,
      why: rule.why,
    })),
  }
}

export const CHECKED_RULE_IDS = Object.freeze(RULES.map(rule => rule.id))
