export const FRONTEND_TOOL_APPROVAL_CAPABILITY = 'external-tool-approval'

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

export function frontendSourceToolCapabilities(sources = []) {
  return frontendSourceTools(sources).some(({ tool }) => (
    tool.policy?.readOnly === false
    && tool.policy?.approval === 'required'
  )) ? [FRONTEND_TOOL_APPROVAL_CAPABILITY] : []
}

export function findFrontendSourceTool(sources, name) {
  const requested = String(name || '')
  return frontendSourceTools(sources).find(({ tool }) => (
    tool.name === requested
  )) || null
}
