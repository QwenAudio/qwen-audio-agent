import {
  assertKnowledgeRetrievalProvider,
  describeKnowledgeRetrievalProvider,
  knowledgeProviderHealth,
  normalizeKnowledgeRetrievalResponse,
} from './retrieval-provider.mjs'

export const FRONTEND_KNOWLEDGE_CAPABILITY = 'knowledge'

function runWithSignal(operation, signal) {
  if (!signal) return Promise.resolve().then(operation)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason
      return operation()
    }).then(resolve, reject).finally(
      () => signal.removeEventListener('abort', aborted),
    )
  })
}

export class FrontendKnowledgeRuntime {
  constructor({
    provider,
    timeoutMs = 10_000,
    maxResultContentChars = 4_000,
  } = {}) {
    this.provider = assertKnowledgeRetrievalProvider(provider)
    this.timeoutMs = timeoutMs
    this.maxResultContentChars = maxResultContentChars
    this.closePromise = null
  }

  capabilities() {
    return [FRONTEND_KNOWLEDGE_CAPABILITY]
  }

  describe() {
    return {
      configured: true,
      capabilities: this.capabilities(),
      provider: describeKnowledgeRetrievalProvider(this.provider),
    }
  }

  async health({ signal } = {}) {
    return knowledgeProviderHealth(this.provider, { signal })
  }

  async search(query, {
    ownerId,
    sessionId,
    turnId,
    traceId,
    knowledgeBaseIds = [],
    filters = {},
    topK = 5,
    signal,
  } = {}) {
    const normalizedQuery = [...String(query || '').trim()].slice(0, 500).join('')
    if (!normalizedQuery) {
      const error = new Error('Knowledge retrieval requires a query.')
      error.code = 'knowledge_query_required'
      throw error
    }
    const trustedOwnerId = String(ownerId || '').trim()
    if (!trustedOwnerId) {
      const error = new Error('Knowledge retrieval requires a trusted owner.')
      error.code = 'knowledge_owner_required'
      throw error
    }
    const boundedTopK = Math.max(1, Math.min(8, Math.trunc(Number(topK) || 5)))
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new DOMException(
        'Knowledge retrieval timed out.',
        'TimeoutError',
      ))
    }, this.timeoutMs)
    const retrievalSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    const request = {
      query: normalizedQuery,
      topK: boundedTopK,
      knowledgeBaseIds: Array.isArray(knowledgeBaseIds)
        ? knowledgeBaseIds
            .map(value => String(value || '').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 8)
        : [],
      filters: filters && typeof filters === 'object' && !Array.isArray(filters)
        ? filters
        : {},
    }
    const context = {
      ownerId: trustedOwnerId,
      sessionId: String(sessionId || ''),
      turnId: String(turnId || ''),
      traceId: String(traceId || ''),
      signal: retrievalSignal,
    }
    let response
    try {
      response = await runWithSignal(
        () => this.provider.retrieve(request, context),
        retrievalSignal,
      )
    } finally {
      clearTimeout(timeout)
    }
    return normalizeKnowledgeRetrievalResponse(response, {
      query: normalizedQuery,
      limit: boundedTopK,
      maxContentChars: this.maxResultContentChars,
    })
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = Promise.resolve().then(() => this.provider.close?.())
    }
    await this.closePromise
  }
}
