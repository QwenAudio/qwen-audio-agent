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
  facts: {
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

// Legacy persisted scope values map onto the current taxonomy. 'long_term'
// named the retention period instead of the content kind and predates the
// content-axis naming (profile/facts/rules/...).
const SCOPE_ALIASES = {
  long_term: 'facts',
}

export function canonicalScope(value) {
  const scope = String(value || '').trim().toLowerCase()
  return SCOPE_ALIASES[scope] || scope
}

// Internal sentinel meaning "no scope filter". Not part of the tool enum:
// the tool schema expresses "all" by omitting the scope argument.
export const ALL_SCOPE = 'all'
export const MEMORY_STORE_SCOPES = Object.keys(MEMORY_SCOPES).filter(
  scope => MEMORY_SCOPES[scope].store === 'memory',
)
export const TOOL_SCOPES = Object.keys(MEMORY_SCOPES)

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
