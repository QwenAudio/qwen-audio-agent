// 多次抽取的一致性分析。
//
// 【为什么用「跑几次是否一致」代替模型自评的 confidence】
// 实测过：同一份 policy 连抽三次（temperature: 0），模型给每条都标 certain，
// 但 order_rules 每次都不同，其中两次对同一句原文给出【相反的顺序】。
// 模型的自评不可信，而多次运行的一致性是可观测的事实。
//
// 学术上这叫 self-consistency，通常用于多数投票提升准确率。
// 这里不投票 —— 用分歧本身定位「哪几条需要人来判断」。
// policy 文本有歧义时，同一个模型多次读必然给出不同结果，
// 那个分歧正是我们要找的信号。

// 每条抽取项生成一个指纹，用于跨运行比对「这是不是同一条」。
// 【指纹要包含结论，不只是主题】
// 「退货窗口 = 30 天」和「退货窗口 = 7 天」是同一个主题的两个结论，
// 必须算作分歧而不是同一条 —— 否则两次给出矛盾数字会被当成一致。
export function fingerprint(item) {
  switch (item.kind) {
    // 【数值类要跟着 topic 一起跳字段归一】
    // 只让 topic 跳字段而 fingerprint 不跳，会把
    // window:apparel=30 与 threshold:return_window_apparel=30 归到同一主题、
    // 却当成两个不同结论 —— 界面上就报“结论冲突”，而它们其实一致。
    case 'threshold':
    case 'window':
      return `value:${entityOf(item)}=${valueOf(item)}`
    case 'escalation':
      return `escalation:${normalize(item.trigger)}`
    case 'order':
      return `order:${normalize(item.before)}->${normalize(item.after)}`
    case 'lookup':
      // 交叉表比对整张表：行数变了、某一格的值变了，都算分歧。
      // 但不比 inputs 的命名 —— reason 与 reason_for_return 是同一个维度的
      // 两种写法，把它们算成冲突只会制造噪声。
      return `lookup:${item.name}:${(item.rows || [])
        .map(row => `${Object.values(row.when || {}).map(normalize).sort().join(',')}=${row.then}`)
        .sort()
        .join('|')}`
    case 'gap':
      return `gap:${normalize(item.topic)}`
    default:
      return `${item.kind}:${normalize(JSON.stringify(item))}`
  }
}

// 主题指纹：只看「说的是哪件事」，不看结论。
// 用它把「同一主题的不同结论」归到一起，这样界面上能并排显示三个版本，
// 而不是当成三条互不相关的项。
//
// 【跨字段归并】模型有时把「apparel 退货窗口 30 天」放进 category_windows，
// 有时放进 thresholds（名字变成 return_window_apparel）。那是同一条规则的
// 两种落位，不该在界面上占两行。所以数值类的主题键用
// 「实体 + 数值 + 单位」，不带字段名。
export function topic(item) {
  switch (item.kind) {
    case 'threshold':
    case 'window':
      return `value:${entityOf(item)}`
    case 'escalation': return `escalation:${normalize(item.trigger)}`
    case 'order': return `order:${[normalize(item.before), normalize(item.after)].sort().join('~')}`
    case 'lookup': return `lookup:${item.name}`
    case 'gap': return `gap:${normalize(item.topic)}`
    default: return `${item.kind}`
  }
}

// 从 threshold 的 name 或 window 的 category 里取出「说的是哪个实体」。
// return_window_apparel → apparel；refund_ceiling → refund_ceiling。
// 剥前缀只在剥完还剩东西时才做，否则 refund_ceiling 会被剥成 ceiling，
// 和另一条 xxx_ceiling 撞在一起。
const VALUE_PREFIXES = ['return_window_', 'window_', 'compensation_', 'fee_']

function entityOf(item) {
  if (item.kind === 'window') return normalize(item.category)
  const name = normalize(item.name)
  for (const prefix of VALUE_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length)
    }
  }
  return name
}

// window 用 days，threshold 用 value。两边其实在说同一件事。
function valueOf(item) {
  return item.kind === 'window' ? item.days : item.value
}

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, '')
}

// gaps 的 topic 是自由文本，措辞每次都不同：
//   「未签收订单的处理边界」「未签收订单的处理流程细化」「未签收订单的处理流程细节」
// 三次抽取写了三种说法，指纹不同就变成三条待裁决 —— 分歧定位被措辞噪声淹没。
//
// 用字符级 Jaccard 相似度聚类。对中文有效，因为同一件事的不同措辞
// 共享大部分字。阈值 0.55 是试出来的：0.7 分不开上面那三条，
// 0.4 会把「换货差价」和「混合支付」误并。
const SIMILARITY_THRESHOLD = 0.55

// 去掉常见的修饰前后缀再比，能显著提高聚类效果。
// 后缀：「…的判定标准」「…的边界」「…的细节」
// 前缀：「未定义…」「未规定…」「未说明…」—— 模型常拿它们开头，
// 而同一件事有时带前缀有时不带。
// escalation 还要去「单笔」「每笔」这类量词：实测到同一条规则
// 一次写「退款金额超过 2000 元」、一次写「单笔退款金额超过 2000 元」。
const NOISE_SUFFIX = /(的?(具体)?(判定|认定|界定|计算)?(标准|边界|细节|细化|方式|形式|机制|流程|范围|条件|说明|时机|时间点|限制)+)$/
const NOISE_PREFIX = /^(未(定义|规定|说明|明确|涉及)|单笔|每笔|单个)/

function denoise(text) {
  return text.replace(NOISE_PREFIX, '').replace(NOISE_SUFFIX, '')
}

function similarity(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const char of a) if (b.has(char)) shared += 1
  return shared / new Set([...a, ...b]).size
}

// 把一批主题键聚成若干簇，返回 原键 → 簇代表键 的映射。
//
// 【只对自由文本类聚类：gap 与 escalation】
// 数值类的主题键是结构化的，精确比对就够 —— 对它们做模糊聚类
// 会把「apparel 30 天」和「accessory 30 天」并掉。
// order 也不聚：它的两端已经排序归一过，而再模糊一层会把
// 「核验身份 → 取消订单」和「核验身份 → 修改地址」归成一条，
// 而它们是两条不同的业务约束。
const CLUSTERED_KINDS = ['gap:', 'escalation:']

function clusterTopics(keys) {
  const mapping = new Map()
  // 按类别分开聚 —— 不能让一条 gap 和一条 escalation 因为文本相似而并掉，
  // 它们在界面上是两种东西（一个是缺口，一个是规则）。
  for (const prefix of CLUSTERED_KINDS) {
    const clusters = []
    for (const key of keys.filter(item => item.startsWith(prefix))) {
      const text = denoise(key.slice(prefix.length))
      const found = clusters.find(cluster => similarity(cluster.text, text) >= SIMILARITY_THRESHOLD)
      if (found) {
        mapping.set(key, found.representative)
      } else {
        clusters.push({ text, representative: key })
        mapping.set(key, key)
      }
    }
  }
  return mapping
}

// runs：多次 partition() 的结果数组，每个形如 { determined, undecided }。
export function consense(runs) {
  const total = runs.length
  if (!total) return { agreed: [], disputed: [], runs: 0 }

  // 先把每次运行的所有项摊平，记下它出现在哪几次里。
  //
  // 【determinedRuns 必须记「运行序号的集合」，不能记次数】
  // 指纹跨字段归并之后，同一次运行里可能有两个对象共享一个指纹
  // （模型把 apparel 30 天同时放进了 category_windows 和 thresholds）。
  // 那时计数器会加两次，于是 count === total 这个判据永远不成立 ——
  // 四条本来确定的时限全被判成「稳定但模糊」。用集合就不受重复影响。
  const seen = new Map()
  for (const [index, run] of runs.entries()) {
    const determined = new Set(run.determined || [])
    for (const item of [...(run.determined || []), ...(run.undecided || [])]) {
      const key = fingerprint(item)
      const entry = seen.get(key) || { item, runs: new Set(), determinedRuns: new Set() }
      entry.runs.add(index)
      if (determined.has(item)) entry.determinedRuns.add(index)
      seen.set(key, entry)
    }
  }

  // 按主题分组，看同一主题下有几种不同结论。
  // gap 类先做一次相似度聚类，把同一件事的不同措辞归到一个代表键上 ——
  // 否则三次抽取写了三种说法就变成三条待裁决。
  const rawTopics = [...new Set([...seen.values()].map(entry => topic(entry.item)))]
  const clusterMapping = clusterTopics(rawTopics)

  const byTopic = new Map()
  for (const [key, entry] of seen) {
    const raw = topic(entry.item)
    const name = clusterMapping.get(raw) || raw
    const group = byTopic.get(name) || []
    group.push({ key, ...entry, count: entry.runs.size })
    byTopic.set(name, group)
  }

  const agreed = []
  const disputed = []

  for (const [name, variants] of byTopic) {
    // 同一主题只有一种结论，且每次运行都给出了它 → 稳定。
    if (variants.length === 1 && variants[0].count === total) {
      // 【还要求它在每次运行里都是「确定项」】
      // 一条每次都被抽出来、但每次都被判为 ambiguous 的项（比如 gaps），
      // 稳定不代表不需要人看 —— 它稳定地需要人看。
      if (variants[0].determinedRuns.size === total) {
        agreed.push({ ...variants[0].item, agreement: `${total}/${total}` })
      } else {
        disputed.push({
          ...variants[0].item,
          agreement: `${total}/${total}`,
          disputeKind: 'stable_but_ambiguous',
          variants: [],
        })
      }
      continue
    }

    // 有多种结论，或某种结论只在部分运行里出现 → 需要人裁决。
    // 排序后取出现次数最多的那个作为默认建议 —— 人可以一键接受。
    const sorted = [...variants].sort((left, right) => right.count - left.count)
    const majority = sorted[0]
    disputed.push({
      ...majority.item,
      agreement: `${majority.count}/${total}`,
      // 三种分歧形态，界面上要区别对待：
      //   conflicting_values  同一主题给出了不同结论 → 并排显示，人选一个
      //   partial_agreement   只有部分运行抽出了它 → 可能是漏抽也可能是幻觉
      disputeKind: variants.length > 1 ? 'conflicting_values' : 'partial_agreement',
      variants: sorted.slice(1).map(entry => ({
        ...entry.item,
        agreement: `${entry.count}/${total}`,
      })),
      topicKey: name,
    })
  }

  // 分歧最大的排前面：出现次数越少越可疑，人应该先看它。
  disputed.sort((left, right) => {
    const leftCount = Number(String(left.agreement).split('/')[0])
    const rightCount = Number(String(right.agreement).split('/')[0])
    return leftCount - rightCount
  })

  return { agreed, disputed, runs: total }
}
