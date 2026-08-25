const SOURCE_KEY = /^[a-z0-9][a-z0-9-]*$/u

export const FRONTEND_MCP_SOURCE_METHODS = Object.freeze([
  'describe',
  'initialize',
  'tools',
  'execute',
  'health',
  'close',
])

export function assertFrontendMcpSource(value, { name = 'FrontendMcpSource' } = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  const missing = FRONTEND_MCP_SOURCE_METHODS.filter(
    method => typeof value[method] !== 'function',
  )
  if (missing.length) {
    throw new TypeError(`${name} is missing required methods: ${missing.join(', ')}`)
  }
  const description = value.describe()
  if (
    !description
    || !SOURCE_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(`${name} describe() returned an invalid identity`)
  }
  return value
}
