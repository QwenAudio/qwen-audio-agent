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
      ...result,
      changed: Math.max(0, Math.trunc(Number(result.changed) || 0)),
      documents: normalizeDocuments(result.documents),
    }
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
