// Single source of truth for frontend memory scopes. Every layer (storage,
// routing, context injection, coordinator envelope, tool protocol) derives
// scope behavior from this registry instead of matching scope names.
//
// kind:     semantic class — 'directive' entries are user-authored standing
//           instructions injected with authority; everything else is passive
//           material the model treats as data.
// store:    backing store — 'memory' (FrontendMemoryStore) or 'profile'
//           (UserProfile).
// label/maxEntries/maxChars: capacity and wording enforced by the memory store.
export const MEMORY_SCOPES = {
  profile: {
    kind: 'profile',
    store: 'profile',
  },
  long_term: {
    kind: 'data',
    store: 'memory',
    label: '前台记忆',
    maxEntries: 32,
    maxChars: 500,
  },
  rules: {
    kind: 'directive',
    store: 'memory',
    label: '长期约定',
    maxEntries: 16,
    maxChars: 200,
  },
}

export const ALL_SCOPE = 'all'
export const MEMORY_STORE_SCOPES = Object.keys(MEMORY_SCOPES).filter(
  scope => MEMORY_SCOPES[scope].store === 'memory',
)
export const TOOL_SCOPES = [...Object.keys(MEMORY_SCOPES), ALL_SCOPE]

export function scopeMeta(scope) {
  return MEMORY_SCOPES[scope] || null
}

export function isToolScope(scope) {
  return TOOL_SCOPES.includes(scope)
}

export function isDirectiveScope(scope) {
  return scopeMeta(scope)?.kind === 'directive'
}

export function storeForScope(scope) {
  return scopeMeta(scope)?.store || null
}
