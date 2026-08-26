import {
  ALL_SCOPE,
  MEMORY_DOCUMENTS,
  canonicalScope,
} from '../core/memory-scopes.mjs'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
} from './memory-provider.mjs'

function normalizeScope(value, fallback = ALL_SCOPE) {
  const scope = canonicalScope(String(value || fallback))
  if (scope !== ALL_SCOPE && !MEMORY_DOCUMENTS.includes(scope)) {
    throw new Error(`unsupported memory scope: ${scope}`)
  }
  return scope
}

export class FrontendMemoryService {
  constructor({ userStore = null, memoryStore = null } = {}) {
    this.stores = { user: userStore, memory: memoryStore }
  }

  describe() {
    return {
      protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
      key: 'markdown',
      label: 'Local Markdown memory',
    }
  }

  list(ownerId, { scope = null } = {}) {
    const target = normalizeScope(scope)
    const scopes = target === ALL_SCOPE ? MEMORY_DOCUMENTS : [target]
    return scopes.flatMap(name => this.stores[name]?.list(ownerId) || [])
  }

  apply(ownerId, changes = []) {
    if (!Array.isArray(changes) || !changes.length) {
      throw new Error('at least one memory change is required')
    }
    const documents = new Set()
    const prepared = changes.map(change => {
      const document = normalizeScope(change?.document)
      if (document === ALL_SCOPE) throw new Error('each change requires a concrete document')
      if (documents.has(document)) throw new Error(`duplicate memory document: ${document}`)
      documents.add(document)
      const store = this.stores[document]
      if (!store) throw new Error(`${document} memory document is unavailable`)
      return {
        document,
        store,
        result: store.prepareEdit(ownerId, {
          edits: change.edits,
          append: change.append,
          expectedRevision: change.expectedRevision,
        }),
      }
    })
    for (const item of prepared) {
      if (item.result.changed) item.store.persist(ownerId, `${item.result.content}\n`)
    }
    return {
      changed: prepared.reduce((sum, item) => sum + item.result.changed, 0),
      documents: prepared.map(item => item.result.document),
    }
  }

  health() {
    return {
      ok: MEMORY_DOCUMENTS.every(scope => this.stores[scope]?.health().ok !== false),
      documents: Object.fromEntries(MEMORY_DOCUMENTS.map(scope => [
        scope,
        this.stores[scope]?.health() || {
          ok: true,
          configured: false,
          warning: null,
        },
      ])),
    }
  }
}
