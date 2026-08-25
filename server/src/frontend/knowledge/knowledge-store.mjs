export const KNOWLEDGE_STORE_METHODS = Object.freeze([
  'describe',
  'putDocument',
  'getDocument',
  'listDocuments',
  'removeDocument',
  'health',
  'close',
])
const STORE_KEY = /^[a-z0-9][a-z0-9-]*$/u

export function assertKnowledgeStore(value, { name = 'KnowledgeStore' } = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  const missing = KNOWLEDGE_STORE_METHODS.filter(
    method => typeof value[method] !== 'function',
  )
  if (missing.length) {
    throw new TypeError(`${name} is missing required methods: ${missing.join(', ')}`)
  }
  const description = value.describe()
  if (
    !description
    || !STORE_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(`${name} describe() returned an invalid identity`)
  }
  return value
}
