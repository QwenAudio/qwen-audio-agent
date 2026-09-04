// 把 domains/*/policy.md 挂成 knowledge 检索源。
//
// 【为什么不用现成的 LocalDomainKnowledgeProvider】
// 那个依赖 DomainLibrary —— 要摘要模型跑一遍生成 gist/sections，还要一套
// 导入管理界面。policy.md 是我们自己写的、固定的几份文件，章节标题就是
// 天然的检索单元，不需要模型再总结一遍。
//
// 【为什么必须有这个 provider】
// 关掉 web_search 之后模型说「我需要查一下《明远优选零售客服细则》」然后
// 查不到 —— 那比引用昆明本地宝还糟：它只剩反问客户或凭常识编两条路。
// 客服说出口的每个数字都该能追到细则第几行，这个 provider 就是那条链的起点。
//
// 检索粒度是【章节】而不是整篇：整篇 3000 字塞进上下文会挤掉对话历史，
// 而客户问的永远是某一条（退货时限、运费谁承担）。

import { readFileSync } from 'node:fs'

const KNOWLEDGE_PROVIDER_PROTOCOL_VERSION = 1

const DOMAIN_FILES = Object.freeze({
  retail: {
    url: new URL('../domains/retail/policy.md', import.meta.url),
    title: '明远优选零售客服细则',
  },
  airline: {
    url: new URL('../domains/airline/policy.md', import.meta.url),
    title: '云途航空客服细则',
  },
})

// 章节切分：## 开头的行。每节记住起始行号 ——
// 【行号是这套东西的价值所在】模型引用一条规则时能带上「第 63 行」，
// 事后审计能核对它有没有编。没有行号的检索等于换了个地方让它编。
function splitSections(text, { domain, title }) {
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = null
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      if (current) sections.push(current)
      current = {
        heading: heading[1].trim(),
        startLine: index + 1,
        body: [],
      }
      continue
    }
    if (current) current.body.push(line)
    // 标题之前的开头几行（文件说明）不进任何章节 —— 它们不是规则。
  }
  if (current) sections.push(current)

  return sections.map((section, order) => ({
    id: `${domain}#${order + 1}`,
    domain,
    documentTitle: title,
    heading: section.heading,
    startLine: section.startLine,
    // 末尾空行去掉，但保留内部换行 —— 表格靠它才能读。
    text: section.body.join('\n').replace(/\n+$/, ''),
  }))
}

// 打分只用字符命中，不做向量。理由和 surfaces.mjs 那边一样：
// 能用规则的地方不该交给模型。policy 只有十来个章节，
// 关键词命中足够把「退货时限」和「运费」分开。
function score(section, query) {
  const needle = query.replace(/\s+/g, '')
  if (!needle) return 0
  const heading = section.heading.replace(/\s+/g, '')
  const body = section.text.replace(/\s+/g, '')

  let hits = 0
  // 【标题命中权重高于正文】
  // 实测证据：查「身份核验」时，「九、转人工」那节正文里反复出现这四个字，
  // 不加权它会排在「一、身份核验」前面。
  //   无加权  九、转人工  |  一、身份核验
  //   有加权  一、身份核验  |  九、转人工
  for (const char of new Set(needle)) {
    if (heading.includes(char)) hits += 3
    if (body.includes(char)) hits += 1
  }
  // 整串命中额外加分 —— 「身份核验」四个字连着出现在标题里，
  // 比四个字分散命中在正文里可信得多。
  if (heading.includes(needle)) hits += 20
  if (body.includes(needle)) hits += 8
  return hits
}

export class PolicyKnowledgeProvider {
  #sections

  // 【一个网关只服务一个域】
  // 第一版把两个域的章节都装进来，实测零售会话查「运费谁承担」时
  // 第二条返回了航空的「免费托运行李额」—— 因为「费」「额」这些字两边都有。
  //
  // 混域不只是排序噪声：零售客服看到航空细则，就有可能拿航空的规则答零售的问题。
  // 客服的信息边界要封闭到域这一层，不只是「不许上网」。
  //
  // 域由环境变量定，和 gateway/assistant/<domain>.md 那份人设配套 ——
  // 一个进程一个域，换域重启，不在运行时切。
  constructor({ domain = process.env.CS_DOMAIN || 'retail' } = {}) {
    const file = DOMAIN_FILES[domain]
    if (!file) {
      throw new Error(`未知的客服域：${domain}（可选 ${Object.keys(DOMAIN_FILES).join(' / ')}）`)
    }
    this.domain = domain
    this.#sections = splitSections(readFileSync(file.url, 'utf8'), { domain, title: file.title })
  }

  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'customer-service-policy',
      label: DOMAIN_FILES[this.domain].title,
      capabilities: { search: true },
    }
  }

  health() {
    return this.#sections.length
      ? { status: 'ready' }
      : { status: 'unconfigured', detail: '没有装载到任何 policy 章节' }
  }

  // 【协议要求的方法名是 retrieve，不是 search】
  // 第一版写成 search，装配时直接抛
  // 「KnowledgeRetrievalProvider is missing required methods: retrieve」。
  // 契约在 server/src/frontend/knowledge/retrieval-provider.mjs:83。
  async retrieve(request = {}, { ownerId } = {}) {
    void ownerId
    const query = String(request.query || '').trim()
    const limit = Math.min(Math.max(Number(request.topK) || 3, 1), 6)

    const ranked = this.#sections
      .map(section => ({ section, points: score(section, query) }))
      .filter(entry => entry.points > 0)
      .sort((left, right) => right.points - left.points)
      .slice(0, limit)

    return {
      results: ranked.map(({ section }) => ({
        id: section.id,
        // 【原文一字不改地交回去】不做摘要、不做改写。
        // 摘要一次就多一次失真机会，而这份文本的全部价值在于它是权威原文。
        content: `《${section.documentTitle}》${section.heading}（第 ${section.startLine} 行起）\n\n${section.text}`,
        source: {
          id: section.id,
          title: `${section.documentTitle} · ${section.heading}`,
          // 不放 uri：本机路径是私有地址，协议会丢弃它。
          // locator 是协议给「非公开位置」留的字段。
          locator: `domains/${section.domain}/policy.md#L${section.startLine}`,
          mimeType: 'text/markdown',
        },
        metadata: {
          domain: section.domain,
          heading: section.heading,
          startLine: section.startLine,
        },
      })),
    }
  }

  // 给测试和探针用，不属于协议。
  sections() {
    return this.#sections
  }
}
