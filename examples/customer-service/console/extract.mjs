// Policy 抽取器：读一份 policy.md，让模型抽出三类东西 ——
// 确定的顺序约束、需要人裁决的歧义、以及数值阈值。
//
// 【为什么产出要分「确定 / 待决定」两栏】ElevenLabs 让用户从零画 Workflow 图，
// 那个成本太高；全自动抽取又会把「必要时转人工」这种歧义悄悄定死。
// 分两栏之后，人只需要处理待决定的那几条，而且每条确定项都带原文行号可追溯。
//
// 抽取结果只用于【生成配置】，运行时不参与任何执行控制。
//
// ── 实测到的稳定性差异（同一份 retail policy 连跑三次，temperature: 0）──
//
//   数值类（阈值、类别时限）  三次完全一致，行号也一致
//   语义类（order_rules）    三次都不同，其中两次对同一句原文抽出【相反的顺序】：
//                            「复述新地址 → 修改地址」与「修改地址 → 复述新地址」
//
// 所以 order_rules 这类不能自动落地，必须逐条过人。数值类可以直接生成配置。
// 这不是 prompt 写得不够好 —— 是「哪个动作在前」本身就依赖对业务的理解，
// 而那份理解不在 policy 文本里。

import { readFileSync } from 'node:fs'
import OpenAI from 'openai'

const SCHEMA_HINT = `{
  "order_rules": [
    {
      "before": "工具名或步骤名",
      "after": "工具名或步骤名",
      "quote": "policy 原文里支持这条的句子，一字不改",
      "confidence": "certain | ambiguous"
    }
  ],
  "thresholds": [
    {
      "name": "简短名称，如 refund_ceiling",
      "value": 数字或 null,
      "unit": "元 | 天 | 小时 | 件 | 次",
      "applies_to": "适用范围，如 单笔退款",
      "quote": "policy 原文",
      "confidence": "certain | ambiguous"
    }
  ],
  "category_windows": [
    { "category": "类别代码", "days": 数字, "quote": "policy 原文" }
  ],
  "lookup_tables": [
    {
      "name": "这张表决定什么，如 free_baggage_allowance",
      "inputs": ["决定结果的维度名，如 memberTier", "cabin"],
      "rows": [
        { "when": { "memberTier": "维度取值", "cabin": "维度取值" }, "then": "结果（数字或字符串）" }
      ],
      "quote": "policy 原文里的一行或表头",
      "confidence": "certain | ambiguous"
    }
  ],
  "escalation_triggers": [
    { "trigger": "触发条件", "quote": "policy 原文", "confidence": "certain | ambiguous" }
  ],
  "gaps": [
    { "topic": "policy 里没写清或没覆盖的点", "why": "为什么需要人来定" }
  ]
}`

const PROMPT = `你在读一份客服业务细则，任务是把里面可以机器执行的约束抽成结构化数据。

严格遵守：
- 每一条都必须给出 quote，且 quote 必须是原文里的完整句子，一字不改。抽不出原文的不要写。
- confidence 只有两个值。原文写了明确的数字、明确的先后顺序、明确的枚举，才算 certain。
  出现「必要时」「较大时」「适当」「原则上」这类没有具体标准的表述，一律 ambiguous。
- 原文没提到的类别、数字、条件，不要补全，不要按常识推测。宁可少抽，不可编造。
- gaps 里写你注意到的空白：某个类别没规定时限、某个阈值只说了「较大」没给数字、
  某条规则的适用边界不清楚。

关于 order_rules，这一项最容易抽错，务必看清：

它要的是【客服在一次通话里，某个动作必须先于另一个动作完成】这种依赖关系，
判断标准是原文里出现了「必须先」「之后才能」「执行前」「在…之前不得」这类明确的时序词。

判定方法（下面用占位符说明形状，不要把占位符当成待抽取的内容）：
  原文出现「做 X 之前必须先做 Y」  → before=Y 的动作短语, after=X 的动作短语
  原文出现「先 Y，然后才能 X」      → 同上

不算，一条都不要抽：
  文档的章节先后。第五条写运费、第六条写退款，这不表示「先算运费再退款」。
  并列关系。「可以取消，也可以改地址」不是顺序。
  章节标题本身。「禁止事项」「域基础」这类不是动作，不能出现在 before/after 里。

before 和 after 必须是动作短语（含动词），不能是章节标题或名词。
quote 必须是你在【用户给你的这份文件里】真实读到的句子。
不要拿本说明里的任何文字当 quote —— 那些是格式说明，不是业务细则。
如果整份文件里只有一条真正的时序依赖，那就只抽一条。抽不到就给空数组。

关于 category_windows：
  days 必须填成数字。原文用表格给出各类别的天数时，category 填类别代码，days 填天数。
  同一条信息不要既放进 category_windows 又放进 thresholds，选前者。
  填不出数字的不要放进这一项，改放到 gaps。

关于 lookup_tables：
  当一个结果由【两个或更多维度交叉】决定时用这一项。典型形态是原文里的二维表：
  行是一个维度，列是另一个维度，格子里是结果。
  inputs 写维度名，rows 里每一格一行。
  单维度的规则不要放这里 —— 那属于 thresholds 或 category_windows。

【不适用的类别要留空数组，不要硬套】
  这份 schema 是通用的，不是每个域都用得上每一项。
  比如「按商品类别计算的退货天数」只有零售域才有；航空域没有这个概念，
  那 category_windows 就该是 []，而不是把舱位等级塞进去、天数填 0。
  宁可少抽一项，也不要为了填满结构而制造一条不存在的规则。

只输出一个 JSON 对象，不要任何解释文字，结构如下：
${SCHEMA_HINT}`

export async function extractPolicy(policyPath, {
  apiKey = process.env.DASHSCOPE_API_KEY,
  baseURL = process.env.DASHSCOPE_BASE_URL
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model = process.env.CS_EXTRACT_MODEL || 'qwen-flash',
  client,
} = {}) {
  const text = readFileSync(policyPath, 'utf8')
  const lines = text.split('\n')
  const openai = client || new OpenAI({ apiKey, baseURL })

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: text },
    ],
    // 抽取要稳定：同一份 policy 反复抽应该得到同样的结果，
    // 否则每次打开配置台看到的待决定项都不一样，人就无从下手。
    temperature: 0,
    response_format: { type: 'json_object' },
  })

  const raw = completion.choices?.[0]?.message?.content || '{}'
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Policy extraction returned invalid JSON: ${raw.slice(0, 200)}`)
  }

  return annotate(parsed, lines)
}

// 章节标题不是动作。模型很容易把文档的章节先后当成业务流程先后，
// 抽出「退款 → 订单取消」这种业务上完全反了的规则。
// 【prompt 里说了不要这么做，但那守不住】—— 代码侧再拦一道。
//
// 判据是【两端都是章节名】，不是任一端。第一版写成任一端就拦，
// 结果把「身份核验 → 办理任何业务」这条正确的规则也降级了 ——
// 「身份核验」既是章节名也是个合法的动作描述，单看它分辨不出来。
// 而「退款 → 订单取消」两端都是章节名，那才是章节顺序被误当成流程。
const SECTION_WORDS = new Set([
  '身份核验', '退货时限', '退货条件', '换货', '运费', '退款',
  '订单取消', '修改收货地址', '转人工', '禁止事项', '域基础',
])

function isSectionTitle(value) {
  const text = String(value || '').trim()
  return !text || SECTION_WORDS.has(text)
}

function looksLikeSectionOrder(before, after) {
  return isSectionTitle(before) && isSectionTitle(after)
}

// 【把 quote 落回行号】模型给的 quote 是文本，人在配置台上要能点回原文。
// 落不回去的 quote 说明模型改写了原句 —— 那条要标出来，不能当证据用。
export function annotate(parsed, lines) {
  // 半角标点也要去掉。模型输出中文时常把「，」写成「,」、把「。」写成「.」——
  // 只清中文标点的话，一句只差标点形态的 quote 就落不回原文，
  // 会被误判成幻觉而降级。
  const strip = value => String(value || '')
    .replace(/[，。、；：「」（）(),.;:*\s|]/g, '')

  const locate = quote => {
    const needle = String(quote || '').trim()
    if (!needle) return null
    const index = lines.findIndex(line => line.includes(needle))
    if (index >= 0) return index + 1
    // 退一步：去掉标点与 markdown 符号再找。模型常把中文标点换成半角，
    // 也常把表格里的 ** 与 | 带进 quote。
    const loose = strip(needle)
    if (!loose) return null
    const fuzzy = lines.findIndex(line => strip(line).includes(loose))
    if (fuzzy >= 0) return fuzzy + 1
    // 再退一步：markdown 表格里一条信息跨多行，模型会把表头说明和
    // 表体行拼成一句（「经济舱 改签手续费 200 元」）。拆开后只要有
    // 一段能落回去，就把那一行当作依据 —— 宁可定到表头行，
    // 也比完全落不回去强。切分符包括空白，因为表格拼接只靠空格分隔。
    for (const piece of needle.split(/[：:，。\s]/).map(strip).filter(part => part.length >= 4)) {
      const partial = lines.findIndex(line => strip(line).includes(piece))
      if (partial >= 0) return partial + 1
    }
    return null
  }

  const withLine = item => {
    const line = locate(item.quote)
    return {
      ...item,
      policyLine: line,
      // quote 落不回原文 = 模型改写了句子。这类不能算 certain，
      // 否则一条被改写过的「规则」会以确定项的身份进配置。
      quoteVerified: line !== null,
      confidence: line === null ? 'ambiguous' : (item.confidence || 'ambiguous'),
    }
  }

  const orderRules = (parsed.order_rules || []).map(item => {
    const annotated = withLine(item)
    return looksLikeSectionOrder(item.before, item.after)
      ? { ...annotated, confidence: 'ambiguous', rejectedReason: 'looks_like_section_order' }
      : annotated
  })

  const categoryWindows = (parsed.category_windows || []).map(item => {
    const annotated = withLine(item)
    const days = typeof item.days === 'number'
      ? item.days
      // 【天数能从 quote 里解析出来就不该麻烦人】模型常把类别放对、
      // 却漏填 days，而 quote 里明明写着「30 天」。这是确定信息，
      // 让它进待决定栏只会淹没真正需要判断的那几条。
      : Number(String(item.quote || '').match(/(\d+)\s*天/)?.[1])
    // 【days <= 0 是可疑的】实测到一次：把航空 policy 丢给抽取器，
    // 它把三个舱位当成「类别时限」，天数全填 0 —— 而 0 恰好是个
    // 合法数字，直接进了确定栏。而「0 天的退货窗口」没有业务意义。
    if (!Number.isFinite(days) || days <= 0) {
      return { ...annotated, confidence: 'ambiguous', rejectedReason: 'missing_or_zero_days' }
    }
    return { ...annotated, days, daysFrom: typeof item.days === 'number' ? 'model' : 'quote' }
  })

  // 二维以上的交叉表。行李额那种「会员等级 × 舱位」的 3×3 表
  // 在旧 schema 里无处存放，于是整张表被默默丢掉。
  const lookupTables = (parsed.lookup_tables || []).map(item => {
    const annotated = withLine(item)
    const rows = Array.isArray(item.rows) ? item.rows : []
    const inputs = Array.isArray(item.inputs) ? item.inputs : []
    // 单维度的不该放这里 —— 那属于 thresholds。
    // 行数少于维度数的乘积说明表没抽全，不能当确定项用。
    if (inputs.length < 2 || rows.length < 2) {
      return { ...annotated, confidence: 'ambiguous', rejectedReason: 'not_a_cross_table' }
    }
    return { ...annotated, inputs, rows }
  })

  return {
    orderRules,
    thresholds: (parsed.thresholds || []).map(withLine),
    categoryWindows,
    lookupTables,
    escalationTriggers: (parsed.escalation_triggers || []).map(withLine),
    gaps: parsed.gaps || [],
  }
}

// 分栏：确定的直接生成配置，待决定的送到人面前。
//
// 【判据是「有可执行的值 + 有原文依据」，不是模型的自我评价】
// 第一版对 category_windows 用 confidence 判断，但 schema 里根本没要求模型
// 给这个字段，于是它一律缺省成 ambiguous —— 四条抽对了的时限全被推给人手填。
// 阈值和时限这类有具体数字的，只要 quote 能落回原文就该算确定。
// confidence 只用在 order / escalation 这类靠语义判断的项上。
export function partition(extracted) {
  const determined = []
  const undecided = []

  const bySemantics = (item, kind) => {
    const entry = { kind, ...item }
    if (item.confidence === 'certain' && item.quoteVerified) determined.push(entry)
    else undecided.push(entry)
  }

  const byValue = (item, kind, value) => {
    const entry = { kind, ...item }
    // 【rejectedReason 优先】annotate 里已经判定过的降级不能在这里被翻盘。
    // 实测到过一次：模型把延误补偿档位塞进 category_windows、days 填 0，
    // annotate 正确地打了 missing_or_zero_days，但它没删 days 字段 ——
    // 而这里只看「value 是不是有限数字」，于是 0 又把它放进了确定栏。
    if (item.rejectedReason) {
      undecided.push(entry)
      return
    }
    if (typeof value === 'number' && Number.isFinite(value) && item.quoteVerified) {
      determined.push(entry)
    } else {
      undecided.push(entry)
    }
  }

  for (const item of extracted.orderRules) {
    // 【order_rules 一律进待决定，不看 confidence】
    // 实测三次抽取，这一项每次都不同，其中两次对同一句原文给出相反的顺序。
    // 一条方向错了的时序规则进了 flows.json，FlowPanel 就会把正确的流程
    // 标成「跳步」—— 那比不显示进度更糟。
    // 保留 confidence 与行号供人参考，但不代替人做决定。
    undecided.push({ kind: 'order', ...item, needsHumanOrder: true })
  }
  for (const item of extracted.escalationTriggers) bySemantics(item, 'escalation')
  for (const item of extracted.categoryWindows) byValue(item, 'window', item.days)
  for (const item of extracted.thresholds) byValue(item, 'threshold', item.value)
  // 交叉表：只要结构完整且 quote 可核就算确定，和数值类一致。
  // 它们是从原文表格抄下来的，不靠语义判断。
  for (const item of extracted.lookupTables || []) {
    const entry = { kind: 'lookup', ...item }
    if (item.rejectedReason || !item.quoteVerified) undecided.push(entry)
    else determined.push(entry)
  }
  for (const gap of extracted.gaps) {
    undecided.push({ kind: 'gap', ...gap, confidence: 'ambiguous', quoteVerified: false })
  }

  return { determined, undecided }
}
