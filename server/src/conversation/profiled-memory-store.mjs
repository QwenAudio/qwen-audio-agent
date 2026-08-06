import {
  ALL_SCOPE,
  TOOL_SCOPES,
  canonicalScope,
  storeForScope,
} from '../core/memory-scopes.mjs'

// Omitted scope means "no filter". ALL_SCOPE remains accepted as an internal
// sentinel for the same meaning.
function normalizeScope(value, fallback = ALL_SCOPE) {
  const scope = canonicalScope(String(value || fallback))
  if (scope !== ALL_SCOPE && !TOOL_SCOPES.includes(scope)) {
    throw new Error(`unsupported memory scope: ${scope}`)
  }
  return scope
}

function scopeTargetsStore(scope, store) {
  return scope === ALL_SCOPE || storeForScope(scope) === store
}

export class ProfiledMemoryStore {
  constructor({ memoryStore, userProfile = null } = {}) {
    this.memoryStore = memoryStore
    this.userProfile = userProfile
  }

  list(ownerId, options = {}) {
    const limit = Math.min(64, Math.max(1, Number(options.limit) || 20))
    const scope = normalizeScope(options.scope)
    const profile = scopeTargetsStore(scope, 'profile')
      ? this.userProfile?.list({ query: options.query }) || []
      : []
    const texts = scopeTargetsStore(scope, 'memory')
      ? this.memoryStore?.list(ownerId, {
          query: options.query,
          limit,
          scope: scope === ALL_SCOPE ? null : scope,
        }) || []
      : []
    return [...profile, ...texts].slice(0, limit)
  }

  remember(ownerId, { scope, content } = {}) {
    const target = normalizeScope(scope, 'facts')
    if (target === ALL_SCOPE) throw new Error('remember requires a concrete memory scope')
    if (storeForScope(target) === 'profile') {
      if (!this.userProfile) throw new Error('user profile is unavailable')
      return this.userProfile.remember(content)
    }
    if (!this.memoryStore) throw new Error('long-term memory is unavailable')
    return this.memoryStore.remember(ownerId, content, { scope: target })
  }

  replace(ownerId, {
    scope,
    ids,
    content,
  } = {}) {
    const target = normalizeScope(scope)
    if (target === ALL_SCOPE) throw new Error('replace requires a concrete memory scope')
    if (storeForScope(target) === 'profile') {
      if (!this.userProfile) throw new Error('user profile is unavailable')
      return this.userProfile.replace({ ids, content })
    }
    if (!this.memoryStore) throw new Error('long-term memory is unavailable')
    return this.memoryStore.replace(ownerId, { ids, content, scope: target })
  }

  forget(ownerId, {
    scope,
    query,
    all = false,
  } = {}) {
    const target = normalizeScope(scope)
    let removed = 0
    if (scopeTargetsStore(target, 'profile')) {
      removed += this.userProfile?.forget({ query, all }) || 0
    }
    if (scopeTargetsStore(target, 'memory')) {
      removed += this.memoryStore?.forget(ownerId, {
        query,
        all,
        scope: target === ALL_SCOPE ? null : target,
      }) || 0
    }
    return removed
  }

  health() {
    return {
      ...(this.memoryStore?.health() || {
        ok: true,
        persistenceEnabled: false,
        warning: null,
        owners: 0,
      }),
      userProfile: this.userProfile?.health() || {
        ok: true,
        configured: false,
        warning: null,
      },
    }
  }
}
