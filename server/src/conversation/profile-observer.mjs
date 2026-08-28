// 画像观察器：槽位池的生产者。
//
// 抽取器（memory-extractor）有一条刻意的硬约束「不得推测」，只记录用户明说的
// 话。观察器补的正是另一半：允许推测，但产物不直接写文档，只能进槽位池攒确认。
// 两者输入相同、挂同一个会话关闭钩子，但【刻意不合并成一次模型调用】——
// 「不得推测」与「允许推测」放进同一个 prompt 会互相污染，而物理隔离这两条
// 链路正是槽位池存在的理由。宁可多一次调用。
//
// 结构性防护（不依赖 prompt 遵守）：
//   证据 quote 必须逐字出现在【用户】发言里。这一条同时挡住三件事：
//     · 模型编造证据
//     · 把助手的话当成用户偏好（对标 OpenClaw 对 untrusted/system 来源候选的
//       结构性剔除——是剔除，不是扣分）
//     · 自我强化循环：USER.md 里已注入的画像会出现在 instructions 而不是对话
//       轮里，因此永远通不过这条校验，不会被当成新证据反复确认
//
// 失败静默：与抽取器一致，绝不延迟或打断会话关闭，绝不发声。

import { PROFILE_FIELDS } from './preference-candidates.mjs'
import { containsSensitiveContent } from '../core/sensitive-content.mjs'

const MAX_OBSERVATIONS_PER_RUN = 5
const MAX_VALUE_CHARS = 120
const MAX_QUOTE_CHARS = 50
// 与 preference-candidates 的 MAX_BASIS_CHARS 同值：判据要说明「凭什么从这句话
// 得出这个结论」，比原话稍长；两处不一致会让落盘时被二次截断。
const MAX_BASIS_CHARS = 80
const RELATIONS = new Set(['same', 'refine', 'contradict'])

// 「值必须锚定在证据里」——本模块的第二道结构性防护。
//
// quote 逐字校验只保证【这句话用户真说过】，不保证【从这句话推得出这个结论】。
// 实测 4 场对话里 3 场栽在后者上，每条都有合法 quote：
//   「题干别太长，学生读着累」          → response_length=brief    （说的是题目）
//   「帮我看看这段 async 代码有没有问题」 → response_length=detailed （原话没提长度）
//   「所有权那块我不太确定」            → response_style=先说结论再展开（凭空）
//   「选项也精简一些」                  → response_style=选项也精简一些（复读原话）
//
// 光靠攒确认挡不住这类错：用户是老师，他每场都会说「题干别太长」，模型每次都同样
// 误推，confirm 稳稳涨到门槛然后晋升。计数只挡随机噪声，挡不住系统性偏差 ——
// 所以必须在入池那一刻判掉推理链，而不是指望重复采样把它筛掉。
//
// 判据是「改写」与「跳跃」之分：结论的字面成分能在证据里找到落点才算改写。
// 用 2-gram 而非分词，因为中文分词要引库，而 2-gram 已经够分：
//   「高中语文老师」的 高中/语文 → 命中「我在市一中教高中语文」
//   「先说结论再展开」的 结论   → 命中「就给结论」，但在「所有权那块」里一个都没有
function valueAnchoredInQuote(value, quote) {
  const bareValue = bareText(value)
  const bareQuote = bareText(quote)
  if (!bareValue || !bareQuote) return false
  if (bareValue.length <= 2) return bareQuote.includes(bareValue)
  for (let index = 0; index + 2 <= bareValue.length; index += 1) {
    if (bareQuote.includes(bareValue.slice(index, index + 2))) return true
  }
  return false
}

// 交互偏好字段：讲的是【助手该怎么回话】，所以必须由指向助手的话产生。
//
// 这里刻意按【字段语义】划分，不按值形态（枚举/自由文本）划分 —— 一开始正是
// 按值形态写的，于是 response_style 因为是自由文本而绕过了这道门，实测漏进
// 「response_style=题干和选项精简」，证据是「题干别太长，学生读着累」，说的
// 明明是题目。两个字段是同一类偏好，判据也必须同一套。
const INTERACTION_FIELDS = new Set(['response_length', 'response_style'])

// 枚举字段的值是 brief/detailed 这样的英文标签，不可能出现在中文原话里，
// 所以锚定判据对它无效，改判「这句话是不是冲着助手说的」。
// 交互偏好只能由指示产生 —— 用户谈题目、文档、代码的长短都不算。
//
// 收「说 / 讲 / 答」的单字而不是只收「说话 / 回答」这类词：真实指令里大量是
// 省略第二人称的祈使句（「说短点」「长话短说」「别绕弯子，直接说重点」），
// 只匹配长词会把它们全部误杀。实测 17 个 case：只收长词 13/17，加上单字 17/17，
// 而「题干别太长」「这一节写得太啰嗦」这些陷阱一个都没漏进来 —— 它们压根不含
// 表达类动词，谈的是题目和文档本身。
const POINTS_AT_ASSISTANT = /(?:你|您|回复|回答|说|讲|答|表达|语气|措辞)/

// 两种错误的代价不对称，所以这两道判据一律取【宁漏勿错】：误收会直接污染
// USER.md 且用户看不见（管理界面没做），而漏收还有抽取器的明说路径兜着
// （hasExplicitUserDirective 管的就是这一类）。判据放宽之前先想清楚这一点。

const FIELD_GUIDE = [
  '- occupation：用户的职业或身份。自由文本。给一个够用的范围即可，不要强行细分。',
  '- special_skills：用户熟悉的具体领域、技术或工具。自由文本，一次最多 3 项。',
  '- response_length：用户希望回复的详略。只能是 brief、normal、detailed 三者之一。',
  '- response_style：用户希望的表达风格或组织方式，例如「先说结论再展开」「语气轻松些」。自由文本。',
].join('\n')

// 输出形态刻意做成【逐字段问答】而不是「自由提取若干条信号」。
//
// 差别不在措辞而在机制：自由提取时「不报」是个消极出口，模型总要凑出几条来；
// 逐字段问答里 unknown 是必须主动选的答案，承认不知道反而成了正常选项。
// A/B 各两轮实测（12 场对话，同一套代码侧校验）：
//   自由提取   该收 6/6   陷阱漏进 0~1 条   技能栏垃圾 4~7 条
//   逐字段问答 该收 4~5/6 陷阱漏进 0 条     技能栏垃圾 0~1 条   unknown 占 42~44%
// 召回掉 1~2 条换掉 4~7 条垃圾是划算的：漏收下次还有机会，误收会进 USER.md
// 且用户看不见删不掉。
//
// basis 有两个作用：一是让模型自检（写不出判据说明该答 unknown），
// 二是落盘之后，用户追问「你怎么知道我是老师的」时答得上来。
const OBSERVER_SYSTEM_PROMPT = [
  '下面是用户在一场对话里说过的话（只有用户的话，没有助手的）。',
  '针对每个字段回答一个问题。答不出来就填 unknown —— 这是完全正当的答案，',
  '大多数对话里多数字段本来就该是 unknown。',
  '',
  '要回答的四个问题：',
  FIELD_GUIDE,
  '',
  '只输出一个 JSON 对象，不要输出任何其他文字：',
  '{"answers":[{"field":"字段名","value":"取值或 unknown","quote":"用户原话片段","basis":"一句话说明凭什么这么判断","vs_known":"first_time|same|refine|contradict"}]}',
  '',
  'vs_known 是本次判断与「当前已知画像」里那个值的关系：',
  '- first_time：画像里这个字段还是（未知）',
  '- same：和画像里记的是同一件事',
  '- refine：同一件事但更精确（老师 → 中学语文老师）',
  '- contradict：和画像里记的冲突（老师 → 程序员）',
  '',
  '规则：',
  '- 四个字段都要出现。答不出的填 value: "unknown"，此时 quote、basis、vs_known 都留空字符串。',
  '- quote 必须逐字照抄用户原话里的一段连续文字，不要改写、不要合并两句话。',
  '- basis 要说明推理依据。如果 basis 写起来很勉强、要绕好几步，说明这个字段该答 unknown。',
  '- response_length 与 response_style 讲的是【助手该怎么回话】。用户在说题目、文档、代码的长短详略，不算。',
  '- special_skills 只填用户【已经掌握】的，不填他正在问的、正在学的、说自己不懂的。多项用「、」分隔。',
  '- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
].join('\n')

// quote 专用：只压缩空格与制表符，【保留换行】。模型常用换行拼接多句，
// 若在这里把 \n 抹成空格，quoteForValue 就分不出句子边界、拆不回单句。
function cleanQuote(value, maxChars) {
  return [...String(value || '').replace(/[ \t]+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

// 只保留字母数字与文字，用于宽松比对 quote 是否真的来自用户发言。
// 逐字全等太脆：ASR 转写的标点本来就不稳定，模型引用时也常顺手改标点。
function bareText(value) {
  return String(value || '').replace(/[^\p{L}\p{N}]+/gu, '')
}

// 只取【用户轮】。助手轮曾经保留过，理由是「太长了」这种话需要指代对象；
// 但那也是污染源 —— 模型会从助手说了什么反推用户偏好。去掉之后，「太长了」
// 这类脱离上下文就读不懂的话本来就该判 unknown，与宁漏勿错的取向一致。
// userText 仍单独留出，用于 quote 逐字校验。
function buildTranscript(messages, maxChars) {
  const lines = []
  const userParts = []
  let used = 0
  for (const message of messages.toReversed()) {
    const content = String(message.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (message.role !== 'user') continue
    const line = `用户: ${content}`
    if (lines.length && used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
    userParts.unshift(content)
  }
  return { lines, userText: userParts.join('\n') }
}

function firstJsonObject(value) {
  const start = value.indexOf('{')
  if (start < 0) return value
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      return value.slice(start, index + 1)
    }
  }
  return value
}

// list 字段（special_skills）的槽位 key 是 `field::value`，所以「Rust、Python」
// 这样一条合并值会变成一个【独立槽位】，与「Rust」不是同一个 —— confirm 各算各的，
// 谁都攒不够。实测第 2 场模型把已知画像整条复述成
// value="Rust、async 代码、生命周期标注"，正是这个形态。
//
// 所以在解析阶段就按分隔符拆开。拆完每一项各自过值锚定校验，于是合并复述里
// 那些本场没提到的项会自然被 value_not_anchored 拦掉，只留下真在原话里的那个。
// 这比拒收整条好：用户确实会说「我主要写 Rust 和一点 Python」，一条 quote 支撑
// 两个值是合理的，两项也都能在原话里找到落点。
const LIST_VALUE_SEPARATORS = /[、,，;；/｜|]+/

function expandListValues(observation) {
  if (PROFILE_FIELDS[observation.field]?.kind !== 'list') return [observation]
  const parts = String(observation.value)
    .split(LIST_VALUE_SEPARATORS)
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [observation]
  return parts.map(part => ({ ...observation, value: part }))
}

// unknown 在这里被消化掉：模型主动认「答不出」的字段直接丢弃，不进后续任何判定，
// 也不记 skip —— 每场四个字段本来就有近一半是 unknown，记下来只会把审计刷满。
// 大小写与前后空白都归一，因为模型偶尔写 "Unknown" 或 "未知"。
//
// 【空串不在这里】。value 为空是模型输出残缺，属于异常，要走 rejectionReason 的
// empty_value 留下痕迹；和「主动认不知道」混为一谈会把这个异常信号藏掉。
const UNKNOWN_VALUES = new Set(['unknown', '未知', 'n/a', 'null', 'none'])

// vs_known 是「本次判断与画像里那个值的关系」，映射到槽位池的 relation。
// first_time 与 same 对槽位池是同一件事（都算又一次确认），刻意在 prompt 里分开问 ——
// 让模型显式区分「画像里本来没有」和「画像里有且一致」，比让它猜一个抽象标签准。
const VS_KNOWN_TO_RELATION = new Map([
  ['first_time', 'same'],
  ['same', 'same'],
  ['refine', 'refine'],
  ['contradict', 'contradict'],
])

function parseObservations(text) {
  const raw = String(text || '').trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed = JSON.parse(firstJsonObject(unfenced))
  // 兼容两种键名：answers 是当前形态，observations 是旧形态，
  // 留着是为了让既有测试与任何还在用旧格式的调用方不至于硬失败。
  const rows = Array.isArray(parsed?.answers)
    ? parsed.answers
    : (Array.isArray(parsed?.observations) ? parsed.observations : null)
  if (!rows) throw new Error('observer output has no answers array')
  return rows
    .slice(0, MAX_OBSERVATIONS_PER_RUN)
    .map(item => ({
      field: String(item?.field || '').trim(),
      value: clean(item?.value, MAX_VALUE_CHARS),
      // 旧格式直接给 relation，新格式给 vs_known
      relation: RELATIONS.has(item?.relation)
        ? item.relation
        : (VS_KNOWN_TO_RELATION.get(String(item?.vs_known || '').trim()) || null),
      quote: cleanQuote(item?.quote, MAX_QUOTE_CHARS),
      basis: clean(item?.basis, MAX_BASIS_CHARS),
    }))
    .filter(item => !UNKNOWN_VALUES.has(item.value.toLowerCase()))
    .flatMap(expandListValues)
}

// 模型常把多句话拼成一个 quote（用换行或顿号连起来）。这里要把它拆回单句，
// 并为每个值挑出【能支撑它自己】的那一段。
//
// 为什么不能直接放过拼接的 quote：bareText 会抹掉换行，而用户轮本身也是拼起来
// 比对的，所以「连续几轮拼成一句」的 quote 恰好能通过 quote_not_from_user。
// 于是 value 就锚定到了整个拼接串上 —— 实测 value="async 编程" 靠
// 「帮我看看这段 async 代码」这句求助话过了校验，而那不是「他会 async」的证据。
//
// 也不能统一取第一段：用户说「我会 Rust、也会 Python」时，Python 该锚定的是
// 第二段。所以先找既来自用户轮、又能锚定这个值的那一段；找不到再退到任意
// 一段来自用户轮的，让后面的 value_not_anchored 去拦。
function quoteForValue(value, quote, bareUserText) {
  const segments = String(quote || '')
    .split(/[\n、；;]+/)
    .map(part => part.trim())
    .filter(Boolean)
  if (segments.length <= 1) return quote
  const fromUser = segments.filter(segment => {
    const bare = bareText(segment)
    return bare && bareUserText.includes(bare)
  })
  if (!fromUser.length) return quote
  return fromUser.find(segment => valueAnchoredInQuote(value, segment))
    || fromUser[0]
}

export class ProfileObserver {
  constructor({
    candidatePool,
    conversationSync,
    audit = null,
    llmCall = null,
    logger = console,
    minUserMessages = 4,
    maxTranscriptChars = 6000,
  } = {}) {
    this.candidatePool = candidatePool
    this.conversationSync = conversationSync
    this.audit = audit
    this.llmCall = llmCall
    this.logger = logger
    this.minUserMessages = minUserMessages
    this.maxTranscriptChars = maxTranscriptChars
  }

  enabled() {
    return typeof this.llmCall === 'function' && Boolean(this.candidatePool)
  }

  // 当前已知画像，交给模型判断 relation。对标 LangMem 把 existing profile
  // 一起喂回去——不给现值，模型没法区分「精化」和「矛盾」。
  knownProfile(ownerId) {
    const slots = this.candidatePool.list(ownerId) || []
    const lines = []
    for (const field of Object.keys(PROFILE_FIELDS)) {
      // 【只放 active】。tentative 是还在攒确认的候选，不是画像 —— 把它当已知
      // 报给模型，模型就不再报同一个值，confirm 卡在 1 永远攒不够（实测：明明
      // 三场都说「我用 Rust」，四轮里只有一轮攒够）。让候选对模型隐形，用户
      // 每次又说到就照样是一条新观察，跨会话确认才真的能累积。
      // 语义上也是这样才对：已知画像 = 已经晋升进 USER.md 的那些。
      const values = slots
        .filter(slot => slot.field === field && slot.state === 'active')
        .map(slot => slot.value)
      lines.push(`${field}: ${values.length ? values.join('、') : '（未知）'}`)
    }
    return lines.join('\n')
  }

  // 会话关闭钩子。刻意不做 debounce：门槛要求跨 ≥2 个会话，而桌面用户可能
  // 短时间内连开几场；用抽取器那样的 30 分钟防抖会直接吃掉这些会话的证据，
  // 让跨会话条件更难达成。少于 minUserMessages 轮的会话本来就推不准，
  // 已经被下面这道门挡掉，实际调用量不大。
  maybeRun({ ownerId, sessionId }) {
    if (!this.enabled()) return null
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) return null
    const messages = this.conversationSync?.list({
      ownerId: safeOwnerId,
      sessionId,
    }) || []
    const userMessages = messages.filter(message => message.role === 'user')
    if (userMessages.length < this.minUserMessages) return null
    return this.run({ ownerId: safeOwnerId, sessionId, messages }).catch(error => {
      this.audit?.record({
        op: 'error',
        ownerId: safeOwnerId,
        error: String(error?.message || error),
      })
      this.logger?.warn?.('preference.observe_failed', {
        error: String(error?.message || error),
      })
    })
  }

  async run({ ownerId, sessionId, messages }) {
    const { lines, userText } = buildTranscript(messages, this.maxTranscriptChars)
    if (!lines.length) return []
    const user = [
      '## 当前已知画像',
      this.knownProfile(ownerId),
      '',
      '## 用户说过的话',
      lines.join('\n'),
    ].join('\n')

    const observations = parseObservations(
      await this.llmCall({ system: OBSERVER_SYSTEM_PROMPT, user }),
    )
    if (!observations.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'no_observation' })
      return []
    }

    const bareUserText = bareText(userText)
    const accepted = []
    for (const raw of observations) {
      // 先把拼接的 quote 拆回能支撑这个值的那一段（见 quoteForValue），再走校验。
      const observation = {
        ...raw,
        quote: quoteForValue(raw.value, raw.quote, bareUserText),
      }
      const reason = this.rejectionReason(observation, bareUserText)
      if (reason) {
        this.audit?.record({
          op: 'skip',
          ownerId,
          reason,
          detail: { field: observation.field },
        })
        continue
      }
      const slot = this.candidatePool.observe({
        ownerId,
        sessionId,
        field: observation.field,
        value: observation.value,
        relation: observation.relation,
        quote: observation.quote,
        basis: observation.basis,
      })
      // 槽位池也会拒（枚举外取值、已被否决的字段），那不是错误，只是没收下。
      if (!slot) {
        this.audit?.record({
          op: 'skip',
          ownerId,
          reason: 'pool_rejected',
          detail: { field: observation.field },
        })
        continue
      }
      accepted.push({ ...observation, confirm: slot.confirm })
    }

    if (accepted.length) {
      this.audit?.record({
        op: 'observe',
        ownerId,
        scope: 'user',
        reason: 'observed',
        detail: accepted.map(item => ({
          field: item.field,
          value: item.value,
          relation: item.relation,
          confirm: item.confirm,
        })),
      })
    }
    this.logger?.debug?.('preference.observe_completed', {
      proposed: observations.length,
      accepted: accepted.length,
    })
    return accepted
  }

  // 返回拒收原因，null 表示通过。审计里能直接看出模型在哪一步不听话。
  rejectionReason(observation, bareUserText) {
    const definition = PROFILE_FIELDS[observation.field]
    if (!definition) return 'unknown_field'
    if (!observation.value) return 'empty_value'
    if (!observation.quote) return 'missing_quote'
    if (containsSensitiveContent(`${observation.value}\n${observation.quote}`)) {
      return 'sensitive'
    }
    // 第一道：证据必须真的来自用户发言
    const bareQuote = bareText(observation.quote)
    if (!bareQuote || !bareUserText.includes(bareQuote)) return 'quote_not_from_user'
    // 第二道：从这条证据推得出这个结论吗（见 valueAnchoredInQuote 的注释）
    // 交互偏好必须由指向助手的话产生，与值是枚举还是自由文本无关。
    if (INTERACTION_FIELDS.has(observation.field)
      && !POINTS_AT_ASSISTANT.test(observation.quote)) {
      return 'quote_not_about_interaction'
    }
    // 枚举值是英文标签，落不到中文原话里，锚定判据对它无效；自由文本字段都要过。
    if (!definition.values) {
      if (!valueAnchoredInQuote(observation.value, observation.quote)) {
        return 'value_not_anchored'
      }
      // 值就是原话本身 —— 模型在复读，没有提取出特征
      if (bareText(observation.value) === bareQuote) return 'value_parrots_quote'
    }
    return null
  }
}

export const OBSERVER_MARKERS = {
  OBSERVER_SYSTEM_PROMPT,
  MAX_OBSERVATIONS_PER_RUN,
}
