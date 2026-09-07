// Single source of truth for the two frontend memory documents. Public context
// records retain the historical `scope` field, while the tool and service call
// them documents to avoid conflating storage location with instruction scope.
//
// kind:     semantic class — 'directive' entries are user-authored standing
//           instructions injected with authority; everything else is passive
//           material the model treats as data.
export const MEMORY_SCOPES = {
  user: {
    kind: 'directive',
    label: '用户偏好',
    maxEntries: 32,
    maxChars: 500,
  },
  memory: {
    kind: 'data',
    label: '长期记忆',
    maxEntries: 32,
    maxChars: 500,
  },
}

// Legacy spellings remain readable so upgrades do not lose existing memories.
// profile and rules used to overlap (both claimed preferred address and stable
// interaction preferences); both now converge on the single user-preferences document.
const SCOPE_ALIASES = {
  profile: 'user',
  rules: 'user',
  facts: 'memory',
  long_term: 'memory',
}

export function canonicalScope(value) {
  const scope = String(value || '').trim().toLowerCase()
  return SCOPE_ALIASES[scope] || scope
}

// Internal sentinel meaning "no scope filter". Not part of the tool enum:
// the tool schema expresses "all" by omitting the scope argument.
export const ALL_SCOPE = 'all'
export const MEMORY_DOCUMENTS = Object.keys(MEMORY_SCOPES)

function scopeMeta(scope) {
  return MEMORY_SCOPES[canonicalScope(scope)] || null
}

export function isMemoryDocument(scope) {
  return MEMORY_DOCUMENTS.includes(canonicalScope(scope))
}

export function isDirectiveScope(scope) {
  return scopeMeta(scope)?.kind === 'directive'
}
