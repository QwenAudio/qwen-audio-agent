import { canonicalScope, isDirectiveScope } from './scopes.mjs'

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function userPreferencesSection(memories = []) {
  const document = memories.find(memory => (
    isDirectiveScope(clean(memory.scope))
  ))
  if (!document?.content) return ''
  const opening = document.revision
    ? `<user_preferences revision="${clean(document.revision)}">`
    : '<user_preferences>'
  return [
    opening,
    String(document.content).trim(),
    '</user_preferences>',
  ].join('\n')
}

function memorySection(memories = []) {
  const document = memories.find(memory => (
    canonicalScope(clean(memory.scope)) === 'memory'
  ))
  if (!document?.content) return ''
  const opening = document.revision
    ? `<user_memory revision="${clean(document.revision)}">`
    : '<user_memory>'
  return [
    opening,
    String(document.content).trim(),
    '</user_memory>',
  ].join('\n')
}

export function buildMemoryContext({ memories = [] } = {}) {
  return [userPreferencesSection(memories), memorySection(memories)].filter(Boolean).join('\n\n')
}
