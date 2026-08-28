// 资料摘要器 —— 让前端知道「这份文件大概是什么」。
//
// 它不是检索引擎。产出只有三样：一句话说明这文件是什么、一个像样的标题、
// 一级章节标题清单。够前端在派活时把话说清楚就行：
//   「去查《信用卡业务手册》的『年费规则』一节」 ← 章节标题是这里来的
// 剩下的检索、定位、读原文，全部由后端拿着路径自己做。
//
// 与会话摘要一致的纪律：失败静默、只读头部、逐条校验后才落盘。

import { containsSensitiveContent } from '../core/sensitive-content.mjs'
import { DOMAIN_LIMITS } from './domain-library.mjs'

const MAX_HEAD_CHARS = 8000

const DOMAIN_SYSTEM_PROMPT = [
  '你在为语音助手登记一份用户提供的资料（手册、规章、教材等），供它日后判断该不该查这份资料、以及该查哪一节。',
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"title":"资料标题","gist":"一句话说明","sections":["一级章节标题"]}',
  '',
  '规则：',
  `- title 用资料自身的名称，不超过 ${DOMAIN_LIMITS.MAX_TITLE_CHARS} 字；正文里找不到就根据内容起一个准确的。`,
  `- gist 一句话说清「这是什么资料、覆盖哪些范围」，不超过 ${DOMAIN_LIMITS.MAX_GIST_CHARS} 字。不要评价，不要写“本文档介绍了”这类套话。`,
  `- sections 是资料的一级章节标题，最多 ${DOMAIN_LIMITS.MAX_SECTIONS} 个，每个不超过 ${DOMAIN_LIMITS.MAX_SECTION_CHARS} 字。`,
  '- sections 必须照抄资料里的原标题，不要改写、不要合并、不要自己编目录。这些标题是日后定位内容的锚点，改了就对不上原文。',
  '- 只看到开头一部分时，就只登记看到的章节，不要推测后面还有什么。',
  '- 没有明显章节结构时 sections 为空数组。',
  '- 不要摘录正文细节、条款内容或数字，那些留给需要时再查原文。',
].join('\n')

export class DomainSummariser {
  constructor({
    library,
    audit = null,
    llmCall = null,
    logger = console,
    maxHeadChars = MAX_HEAD_CHARS,
  } = {}) {
    this.library = library
    this.audit = audit
    this.llmCall = llmCall
    this.logger = logger
    this.maxHeadChars = maxHeadChars
  }

  enabled() {
    return typeof this.llmCall === 'function' && Boolean(this.library)
  }

  // 导入后调用。失败只是没有摘要，资料本身已经落盘、路径已经可用 ——
  // 所以这里永不抛错。
  maybeRun({ ownerId, id }) {
    if (!this.enabled()) return null
    const entry = this.library.get(ownerId, id)
    if (!entry || entry.summarised) return null
    return this.run({ ownerId, entry }).catch(error => {
      this.audit?.record({
        op: 'error',
        ownerId,
        error: `资料摘要失败：${String(error?.message || error)}`,
      })
      this.logger?.warn?.('domain.summarise_failed', {
        error: String(error?.message || error),
      })
      return null
    })
  }

  async run({ ownerId, entry }) {
    const head = this.library.readHead(entry, this.maxHeadChars)
    if (!head.trim()) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'unreadable_document' })
      return null
    }

    let parsed
    try {
      const reply = await this.llmCall({
        system: DOMAIN_SYSTEM_PROMPT,
        user: [
          `## 文件名\n${entry.filename}`,
          `## 内容开头\n${head}`,
        ].join('\n\n'),
      })
      parsed = JSON.parse(String(reply || '').replace(/^```(?:json)?|```$/gm, '').trim())
    } catch (error) {
      this.audit?.record({
        op: 'error',
        ownerId,
        error: `资料摘要回复无法解析：${String(error?.message || error)}`,
      })
      return null
    }

    const title = String(parsed?.title || '').trim()
    const gist = String(parsed?.gist || '').trim()
    const sections = Array.isArray(parsed?.sections) ? parsed.sections : []
    // 资料本体不过敏感闸门（手册里写「重置密码流程」是正常的），但摘要是模型
    // 产出的自由文本，可能把示例凭据抄进来，这里仍然要挡一道。
    if (containsSensitiveContent(`${title}\n${gist}\n${sections.join('\n')}`)) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'sensitive_summary' })
      return null
    }

    const updated = this.library.attachSummary({
      ownerId,
      id: entry.id,
      title,
      gist,
      sections,
    })
    if (!updated) return null
    this.audit?.record({
      op: 'observe',
      ownerId,
      scope: 'domain',
      reason: 'summarised',
      detail: { title: updated.title, sections: updated.sections.length },
    })
    this.logger?.debug?.('domain.summarised', {
      title: updated.title,
      sections: updated.sections.length,
    })
    return updated
  }

  // 补齐历史欠账：进程重启前导入但没来得及摘要的资料。
  async catchUp({ ownerId }) {
    if (!this.enabled()) return []
    const done = []
    for (const entry of this.library.pendingSummary(ownerId)) {
      const updated = await this.run({ ownerId, entry }).catch(() => null)
      if (updated) done.push(updated)
    }
    return done
  }
}

export const DOMAIN_SUMMARISER_MARKERS = { DOMAIN_SYSTEM_PROMPT }
