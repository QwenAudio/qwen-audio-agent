import { KNOWLEDGE_PROVIDER_PROTOCOL_VERSION } from './retrieval-provider.mjs'

// 本机资料库的 KnowledgeRetrievalProvider 实现。
//
// 【为什么放在 frontend/knowledge 而不是 domain/】层依赖只允许 domain 依赖
// core / domain / shared —— 让「用户给的手册」去依赖前台知识协议是反向耦合。
// 这里是协议侧的一个适配器：它认识 DomainLibrary 的公开读接口（search），
// 但 DomainLibrary 不知道它存在。
//
// 它把「用户指了一份本机文件」这件事接到主线的知识检索边界上，而不是另开一套
// 前台知识入口。管理动作（导入、列出、删除、PDF 转换）留在 DomainLibrary 里 ——
// 按 knowledge 协议的划分，入库与删除不属于 V1，属于独立的管理扩展。
//
// 【与外部 RAG Provider 不能并存】装配处是 knowledgeProvider || knowledgeRetrievalProvider，
// 一个 Gateway 只挂一个 Provider。这是 Provider 模式的正常语义，不是缺陷：
// 用户配了企业知识服务，说明他已有更完整的方案。真要两者并存，宿主自己写一层
// 把两个 Provider 包起来（按 knowledgeBaseIds 路由或合并结果）即可，
// 那是应用层的自由，不需要核心支持。
//
// 【返回什么】刻意不返回正文。content 是「标题 + 一句说明 + 章节标题」，
// 正文位置放在 source.locator 里交给后端自己读。这条判据是本方案的核心：
// 前端每份资料的占用与文档大小无关（≈200 字符），一份 3 页备忘与一份 300 页
// 手册在这里一样大。协议要求 content 非空（空的会被丢弃），所以不能只给路径 ——
// 但给一段有界的摘要同样满足轻量，而且比路径更能帮模型判断该不该用这份资料。
export class LocalDomainKnowledgeProvider {
  constructor({ library, key = 'local-domain', label = '本机资料库' } = {}) {
    if (!library) throw new TypeError('DomainKnowledgeProvider requires a domain library')
    this.library = library
    this.key = key
    this.label = label
  }

  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: this.key,
      label: this.label,
      capabilities: {
        // 子串匹配的名次，不是相关性分数
        scores: false,
        // 没有公开 URL，引用无从生成
        citations: false,
        filters: false,
      },
    }
  }

  async health() {
    // 目录没配置时报 unconfigured，而不是假装 ready 然后每次检索都空手而归。
    return this.library.configured()
      ? { status: 'ready' }
      : { status: 'unconfigured', message: '资料库未配置存放目录。' }
  }

  async retrieve(request, context) {
    // ownerId 只从 Gateway 注入的 context 取 —— 协议明确要求不得从模型参数接受
    // 租户身份，否则模型可以报别人的 ownerId 去读别人的资料。
    const ownerId = String(context?.ownerId || '')
    if (!ownerId || !this.library.configured()) return { results: [] }

    const entries = this.library.search({
      ownerId,
      keyword: request?.query || '',
      limit: request?.topK || 5,
    })

    return {
      results: entries.map(entry => ({
        id: entry.id,
        content: describeEntry(entry),
        source: {
          id: entry.id,
          title: entry.title || entry.filename,
          // 不放 uri：本机路径是私有地址，协议会丢弃它且不生成引用。
          // locator 是协议为「非公开位置」留的字段，后端拿它去读文件。
          locator: entry.path,
          mimeType: 'text/markdown',
        },
        metadata: {
          filename: entry.filename,
          sections: entry.sections.length,
        },
      })),
    }
  }
}

// 一条资料的自我介绍：标题、一句说明、章节标题。
//
// 章节标题必须照抄原文 —— 它是后端 grep 的锚点，改写了就对不上。
// 这也是为什么这里不做任何美化或翻译。
function describeEntry(entry) {
  const lines = [
    `《${entry.title || entry.filename}》`,
    entry.gist ? entry.gist : '',
    entry.sections.length ? `章节：${entry.sections.join('、')}` : '',
    `正文在 ${entry.path}，需要原文时读这个文件。`,
  ]
  return lines.filter(Boolean).join('\n')
}
