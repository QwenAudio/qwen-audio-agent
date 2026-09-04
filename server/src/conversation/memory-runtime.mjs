import {
  assertMemoryProvider,
  describeMemoryProvider,
  normalizeMemoryProviderHealth,
} from './memory-provider.mjs'
import {
  canonicalScope,
  isMemoryDocument,
} from '../core/memory-scopes.mjs'

function clean(value, maxChars) {
  return [...String(value || '').replaceAll('\0', '').trim()]
    .slice(0, maxChars)
    .join('')
}

function normalizeDocuments(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('MemoryProvider documents must be an array')
  }
  const documents = []
  const scopes = new Set()
  for (const candidate of value.slice(0, 8)) {
    const scope = canonicalScope(candidate?.scope)
    const content = clean(candidate?.content, 8_000)
    if (!isMemoryDocument(scope) || !content || scopes.has(scope)) continue
    scopes.add(scope)
    documents.push({
      id: clean(candidate?.id, 160) || `${scope}_document`,
      scope,
      content,
      format: candidate?.format === 'text' ? 'text' : 'markdown',
      revision: clean(candidate?.revision, 160),
      editable: candidate?.editable !== false,
    })
  }
  return documents
}

function normalizeQueryResult(value) {
  if (Array.isArray(value)) {
    return { memories: normalizeDocuments(value), context: '' }
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('MemoryProvider query() must return an object or documents array')
  }
  return {
    memories: normalizeDocuments(value.memories || value.documents || []),
    context: clean(value.context, 8_000),
  }
}

export class FrontendMemoryRuntime {
  constructor({ provider } = {}) {
    this.provider = assertMemoryProvider(provider)
    this.closePromise = null
  }

  describe() {
    return {
      configured: true,
      provider: describeMemoryProvider(this.provider),
    }
  }

  capabilities() {
    return describeMemoryProvider(this.provider).capabilities
  }

  ownsSessionObservation() {
    return this.capabilities().sessionObservation
  }

  ownsAudioStreamObservation() {
    return this.capabilities().audioStreamObservation
  }

  list(ownerId, options = {}) {
    const documents = this.provider.list(ownerId, options)
    if (documents && typeof documents.then === 'function') {
      throw new TypeError(
        'MemoryProvider list() must return a synchronous Realtime snapshot',
      )
    }
    return normalizeDocuments(documents)
  }

  async apply(ownerId, changes = [], context = {}) {
    const result = await this.provider.apply(ownerId, changes, context)
    if (!result || typeof result !== 'object' || !Array.isArray(result.documents)) {
      throw new TypeError(
        'MemoryProvider apply() must return changed and documents',
      )
    }
    return {
      changed: Math.max(0, Math.trunc(Number(result.changed) || 0)),
      documents: normalizeDocuments(result.documents),
    }
  }

  async query(ownerId, query, options = {}, context = {}) {
    const text = clean(query, 2_000)
    if (!text || typeof this.provider.query !== 'function') {
      return {
        memories: this.list(ownerId, options),
        context: '',
      }
    }
    return normalizeQueryResult(
      await this.provider.query(ownerId, text, options, context),
    )
  }

  async observe(ownerId, exchange = {}, context = {}) {
    if (!this.ownsSessionObservation()) return { observed: false }
    const result = await this.provider.observe(ownerId, exchange, context)
    return result && typeof result === 'object'
      ? { ...result, observed: result.observed !== false }
      : { observed: true }
  }

  observeAudio(ownerId, event = {}, context = {}) {
    if (!this.ownsAudioStreamObservation()) return { observed: false }
    const result = this.provider.observeAudio(ownerId, event, context)
    if (result && typeof result.then === 'function') {
      throw new TypeError(
        'MemoryProvider observeAudio() must be synchronous on the audio hot path',
      )
    }
    return result && typeof result === 'object'
      ? { ...result, observed: result.observed !== false }
      : { observed: true }
  }

  async flush(ownerId, context = {}) {
    if (typeof this.provider.flush !== 'function') return { flushed: false }
    await this.provider.flush(ownerId, context)
    return { flushed: true }
  }

  health() {
    const health = typeof this.provider.health === 'function'
      ? this.provider.health()
      : { ok: true }
    if (health && typeof health.then === 'function') {
      throw new TypeError('MemoryProvider health() must return a synchronous snapshot')
    }
    return {
      ...normalizeMemoryProviderHealth(health),
      configured: true,
      provider: describeMemoryProvider(this.provider),
    }
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = Promise.resolve().then(() => this.provider.close?.())
    }
    await this.closePromise
  }
}
