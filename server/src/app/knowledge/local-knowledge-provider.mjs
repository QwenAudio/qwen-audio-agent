import { KNOWLEDGE_PROVIDER_PROTOCOL_VERSION } from '../../frontend/knowledge/retrieval-provider.mjs'
import { classifySource } from '../../domain/domain-library.mjs'

const MAX_SEARCH_DOCUMENT_CHARS = 240_000
const MAX_CHUNK_CHARS = 1_600
const QUERY_STOP_TERMS = new Set([
  '一下', '什么', '怎么', '如何', '是否', '可以', '这个', '那个', '相关', '有关',
])

function clean(value) {
  return String(value || '').trim()
}

function publicDocument(entry) {
  if (!entry) return null
  return {
    id: entry.id,
    title: entry.title,
    gist: entry.gist,
    sections: entry.sections,
    path: entry.path,
    filename: entry.filename,
    bytes: entry.bytes,
    imported_at: entry.importedAt,
    source: entry.source,
    summarised: entry.summarised,
  }
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function queryTerms(query) {
  const source = clean(query).toLowerCase()
  const terms = new Set()
  for (const token of source.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) || []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4 && !QUERY_STOP_TERMS.has(token)) terms.add(token)
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2)
        if (!QUERY_STOP_TERMS.has(pair)) terms.add(pair)
      }
    } else if (token.length >= 2) {
      terms.add(token)
    }
  }
  return [...terms]
}

function markdownChunks(markdown) {
  const chunks = []
  let heading = ''
  let body = ''
  const flush = () => {
    const characters = [...clean(body)]
    for (let index = 0; index < characters.length; index += MAX_CHUNK_CHARS) {
      chunks.push({
        heading,
        text: characters.slice(index, index + MAX_CHUNK_CHARS).join(''),
      })
    }
    body = ''
  }
  for (const line of String(markdown || '').split(/\r?\n/u)) {
    const nextHeading = line.match(/^#{1,6}\s+(.+)$/u)
    if (nextHeading) {
      flush()
      heading = clean(nextHeading[1])
      continue
    }
    const addition = `${body ? '\n' : ''}${line}`
    if ((body.length + addition.length) > MAX_CHUNK_CHARS && clean(body)) flush()
    body += addition
  }
  flush()
  return chunks
}

function scoreChunk(entry, chunk, query, terms) {
  const metadata = normalized([
    entry.title,
    entry.filename,
    entry.gist,
    ...(entry.sections || []),
  ].join(' '))
  const content = normalized(`${chunk.heading}\n${chunk.text}`)
  const exact = normalized(query)
  let score = 0
  if (exact && metadata.includes(exact)) score += 80
  if (exact && content.includes(exact)) score += 60
  for (const term of terms) {
    const needle = normalized(term)
    if (metadata.includes(needle)) score += 12
    if (content.includes(needle)) score += 8
  }
  return score
}

/**
 * Basic local KnowledgeProvider. An Agent may normalize rich documents during
 * ingestion; retrieval itself is deterministic and returns real excerpts.
 */
export class LocalKnowledgeProvider {
  constructor({
    library,
    summariser = null,
    documentConverter = null,
    key = 'local-domain',
    label = '本机资料库',
  } = {}) {
    if (!library) throw new TypeError('LocalKnowledgeProvider requires a document library')
    this.library = library
    this.summariser = summariser
    this.documentConverter = documentConverter
    this.key = key
    this.label = label
  }

  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: this.key,
      label: this.label,
      capabilities: {
        filters: false,
        scores: true,
        citations: false,
        ingestion: true,
        management: true,
      },
    }
  }

  async health() {
    return this.library.configured()
      ? { status: 'ready' }
      : { status: 'unconfigured', message: '资料库未配置存放目录。' }
  }

  async ingest(request, context = {}) {
    const ownerId = clean(context.ownerId)
    const sourcePath = clean(request?.source?.path ?? request?.path)
    let entry
    if (classifySource(sourcePath) === 'convertible') {
      if (!this.documentConverter) {
        const error = new Error('当前没有可用的文档转换器，请先把文件转成 Markdown。')
        error.code = 'document_converter_unavailable'
        throw error
      }
      const target = this.library.conversionTarget({ ownerId, sourcePath })
      await this.documentConverter.convert({
        sourcePath,
        targetPath: target.path,
      }, context)
      entry = this.library.import({ ownerId, sourcePath: target.path })
    } else {
      entry = this.library.import({ ownerId, sourcePath })
    }
    const summarised = this.summariser
      ? await this.summariser.maybeRun({ ownerId, id: entry.id })
      : null
    return { document: publicDocument(summarised || entry) }
  }

  async list(_request, context = {}) {
    return {
      documents: this.library.list(clean(context.ownerId)).map(publicDocument),
    }
  }

  async remove(request, context = {}) {
    const document = this.library.remove({
      ownerId: clean(context.ownerId),
      id: clean(request?.documentId ?? request?.id),
    })
    return { removed: Boolean(document), document: publicDocument(document) }
  }

  async retrieve(request, context = {}) {
    const ownerId = clean(context.ownerId)
    if (!ownerId || !this.library.configured()) return { results: [] }
    const query = clean(request?.query)
    const terms = queryTerms(query)
    const candidates = []
    for (const entry of this.library.list(ownerId)) {
      const markdown = this.library.readHead(entry, MAX_SEARCH_DOCUMENT_CHARS)
      const chunks = markdownChunks(markdown)
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const score = scoreChunk(entry, chunk, query, terms)
        if (!score) continue
        candidates.push({ entry, chunk, index, score })
      }
    }
    candidates.sort((left, right) => right.score - left.score)
    const limit = Math.max(1, Math.min(8, Number(request?.topK) || 5))
    return {
      results: candidates.slice(0, limit).map(({ entry, chunk, index, score }) => ({
        id: `${entry.id}:${index + 1}`,
        content: [
          `《${entry.title || entry.filename}》`,
          chunk.heading ? `## ${chunk.heading}` : '',
          chunk.text,
        ].filter(Boolean).join('\n'),
        score,
        source: {
          id: entry.id,
          title: entry.title || entry.filename,
          locator: chunk.heading || `chunk=${index + 1}`,
          mimeType: 'text/markdown',
        },
        metadata: { filename: entry.filename },
      })),
    }
  }
}
