const SOURCE_KEY = /^[a-z0-9][a-z0-9-]*$/u

export const FRONTEND_TOOL_SOURCE_METHODS = Object.freeze([
  'describe',
  'initialize',
  'tools',
  'execute',
  'health',
  'close',
])

export function assertFrontendToolSource(value, {
  name = 'FrontendToolSource',
} = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  const missing = FRONTEND_TOOL_SOURCE_METHODS.filter(
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

export function frontendSourceTools(sources = []) {
  const catalog = []
  const names = new Set()
  for (const source of sources) {
    for (const tool of source.tools()) {
      const name = String(tool?.name || '').trim()
      if (!name || names.has(name)) {
        throw new Error(`Invalid or duplicate frontend source tool: ${name || '(unnamed)'}`)
      }
      names.add(name)
      catalog.push({ source, tool })
    }
  }
  return catalog
}

export function frontendSourceToolDefinitions(sources = []) {
  return frontendSourceTools(sources).map(({ tool }) => tool.definition)
}

export function findFrontendSourceTool(sources, name) {
  const requested = String(name || '')
  return frontendSourceTools(sources).find(({ tool }) => (
    tool.name === requested
  )) || null
}
