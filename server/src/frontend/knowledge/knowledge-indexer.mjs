import { createHash } from 'node:crypto'
import { assertDocumentExtractor } from './document-extractor.mjs'
import { assertKnowledgeStore } from './knowledge-store.mjs'

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceBuffer(content) {
  if (typeof content === 'string') return Buffer.from(content)
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  }
  return Buffer.alloc(0)
}

export function chunkDocumentText(text, {
  chunkChars = 1_200,
  overlapChars = 120,
  maxChunks = 256,
} = {}) {
  const source = String(text || '').trim()
  if (!source) return []
  const size = Math.max(200, Math.trunc(chunkChars))
  const overlap = Math.max(0, Math.min(Math.trunc(overlapChars), size / 3))
  const chunks = []
  let offset = 0
  while (offset < source.length && chunks.length < maxChunks) {
    let end = Math.min(source.length, offset + size)
    if (end < source.length) {
      const window = source.slice(offset, end)
      const minimum = Math.floor(window.length * 0.6)
      const candidates = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' '),
      ].filter(index => index >= minimum)
      if (candidates.length) end = offset + Math.max(...candidates) + 1
    }
    const content = source.slice(offset, end).trim()
    if (content) chunks.push(content)
    if (end >= source.length) {
      offset = source.length
      break
    }
    offset = Math.max(offset + 1, end - overlap)
  }
  if (offset < source.length && chunks.length >= maxChunks) {
    const error = new Error('Document requires more chunks than the configured limit.')
    error.code = 'document_chunk_limit_exceeded'
    throw error
  }
  return chunks
}

export class KnowledgeIndexer {
  constructor({
    extractor,
    store,
    taskManager,
    chunkChars = 1_200,
    overlapChars = 120,
    maxChunks = 256,
  } = {}) {
    this.extractor = assertDocumentExtractor(extractor)
    this.store = assertKnowledgeStore(store)
    if (!taskManager || typeof taskManager.createSystemJob !== 'function') {
      throw new TypeError('KnowledgeIndexer requires a TaskManager with createSystemJob()')
    }
    this.taskManager = taskManager
    this.chunkOptions = { chunkChars, overlapChars, maxChunks }
  }

  documentIdentity(source) {
    const bytes = sourceBuffer(source?.content)
    const revision = digest(bytes)
    const stableSource = String(
      source?.id || source?.filename || source?.title || revision,
    ).trim()
    return {
      documentId: `doc_${digest(stableSource).slice(0, 24)}`,
      revision,
    }
  }

  index({ ownerId, sessionId = 'system', source }) {
    const owner = String(ownerId || '').trim()
    if (!owner) throw new Error('Knowledge indexing requires an owner id.')
    const { documentId, revision } = this.documentIdentity(source)
    return this.taskManager.createSystemJob({
      ownerId: owner,
      sessionId,
      kind: 'knowledge_index',
      objective: `Index document ${String(source?.filename || source?.title || documentId)}`,
      laneKey: `knowledge:${owner}`,
      laneLimit: 1,
      runner: async (_objective, context) => {
        const extracted = await this.extractor.extract(source, {
          signal: context.signal,
        })
        const chunks = chunkDocumentText(extracted.text, this.chunkOptions)
        const document = await this.store.putDocument(owner, {
          id: documentId,
          title: extracted.title,
          mimeType: extracted.mimeType,
          revision,
          source: {
            kind: String(source?.kind || 'document'),
            label: String(source?.filename || source?.title || extracted.title),
          },
          chunks: chunks.map(text => ({ text })),
        })
        return {
          content: `Indexed ${document.id} (${document.chunkCount} chunks).`,
        }
      },
    })
  }

  async remove(ownerId, documentId) {
    return this.store.removeDocument(ownerId, documentId)
  }

  async list(ownerId) {
    return this.store.listDocuments(ownerId)
  }
}
