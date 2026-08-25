import { assertKnowledgeStore } from './knowledge-store.mjs'
import {
  assertKnowledgeRetrievalProvider,
  normalizeKnowledgeRetrievalResponse,
} from './retrieval-provider.mjs'

export const FRONTEND_KNOWLEDGE_CAPABILITY = 'knowledge'

function mergeChunks(chunks = []) {
  const ordered = [...chunks].sort((left, right) => left.ordinal - right.ordinal)
  let content = ''
  let cursor = 0
  for (const chunk of ordered) {
    const text = String(chunk?.text || '')
    if (!text) continue
    if (Number.isInteger(chunk.start) && Number.isInteger(chunk.end)) {
      if (chunk.start > cursor && content) content += '\n'
      const overlap = Math.max(0, cursor - chunk.start)
      content += text.slice(overlap)
      cursor = Math.max(cursor, chunk.end)
      continue
    }
    let overlap = 0
    const maximum = Math.min(content.length, text.length, 1_200)
    for (let size = maximum; size > 0; size -= 1) {
      if (content.endsWith(text.slice(0, size))) {
        overlap = size
        break
      }
    }
    content += `${content && !overlap ? '\n' : ''}${text.slice(overlap)}`
  }
  return content.trim()
}

export class FrontendKnowledgeRuntime {
  constructor({
    store,
    indexer,
    retrievalProvider,
    maxFullContextChars = 48_000,
    maxFullContextBytes = 48 * 1024,
    maxSearchTextChars = 4_000,
  } = {}) {
    this.store = assertKnowledgeStore(store)
    if (
      !indexer
      || typeof indexer.index !== 'function'
      || typeof indexer.wait !== 'function'
    ) {
      throw new TypeError('FrontendKnowledgeRuntime requires a KnowledgeIndexer')
    }
    this.indexer = indexer
    this.retrievalProvider = assertKnowledgeRetrievalProvider(retrievalProvider)
    this.maxFullContextChars = maxFullContextChars
    this.maxFullContextBytes = maxFullContextBytes
    this.maxSearchTextChars = maxSearchTextChars
  }

  capabilities() {
    return this.retrievalProvider.isConfigured()
      ? [FRONTEND_KNOWLEDGE_CAPABILITY]
      : []
  }

  describe() {
    return {
      capabilities: this.capabilities(),
      store: this.store.describe(),
      retrievalProvider: this.retrievalProvider.describe(),
    }
  }

  async search(query, {
    ownerId,
    documentIds,
    limit = 5,
    signal,
  } = {}) {
    if (!this.retrievalProvider.isConfigured()) {
      throw new Error('Knowledge Retrieval Provider is not configured.')
    }
    const boundedLimit = Math.max(1, Math.min(8, Math.trunc(Number(limit) || 5)))
    const response = await this.retrievalProvider.retrieve(query, {
      ownerId,
      documentIds,
      limit: boundedLimit,
      signal,
    })
    return normalizeKnowledgeRetrievalResponse(response, {
      query,
      limit: boundedLimit,
      maxTextChars: this.maxSearchTextChars,
    })
  }

  async read(ownerId, documentId) {
    const document = await this.store.getDocument(ownerId, documentId)
    if (!document) return null
    const content = mergeChunks(document.chunks)
    if (
      [...content].length > this.maxFullContextChars
      || Buffer.byteLength(content, 'utf8') > this.maxFullContextBytes
    ) {
      const error = new Error('Document exceeds the full-context limit; use retrieval instead.')
      error.code = 'knowledge_full_context_too_large'
      throw error
    }
    return {
      id: document.id,
      title: document.title,
      mimeType: document.mimeType,
      revision: document.revision,
      content,
    }
  }

  async list(ownerId) {
    return this.store.listDocuments(ownerId)
  }

  async remove(ownerId, documentId) {
    return this.store.removeDocument(ownerId, documentId)
  }

  async index({ ownerId, sessionId, sources = [] }) {
    const uniqueSources = [...new Map(sources.map(source => {
      const identity = this.indexer.documentIdentity(source)
      return [`${identity.documentId}\u0000${identity.revision}`, source]
    })).values()]
    const jobs = uniqueSources.map(source => ({
      source,
      identity: this.indexer.documentIdentity(source),
      job: this.indexer.index({ ownerId, sessionId, source }),
    }))
    const outcomes = await Promise.all(jobs.map(entry => this.indexer.wait(entry.job.id)))
    const documents = []
    const failures = []
    for (let index = 0; index < jobs.length; index += 1) {
      const entry = jobs[index]
      const outcome = outcomes[index]
      if (outcome?.status !== 'completed') {
        failures.push({
          title: String(entry.source?.filename || entry.source?.title || 'Document'),
          error: String(outcome?.error || 'Indexing failed.'),
        })
        continue
      }
      const document = await this.store.getDocument(
        ownerId,
        entry.identity.documentId,
      )
      if (document) {
        documents.push({
          id: document.id,
          title: document.title,
          mimeType: document.mimeType,
          revision: document.revision,
          chunkCount: document.chunks.length,
        })
      }
    }
    return { documents, failures }
  }
}
