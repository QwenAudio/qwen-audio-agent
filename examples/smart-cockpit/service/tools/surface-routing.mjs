import { readFileSync } from 'node:fs'

export const SURFACE_FRONTEND = 'frontend'
export const SURFACE_BACKEND = 'backend'
export const COCKPIT_SURFACE_ROUTING_URL = new URL('./surface-routing.json', import.meta.url)

export const DEFAULT_COCKPIT_DOMAIN_SURFACES = Object.freeze({
  vehicle: SURFACE_FRONTEND,
  music: SURFACE_FRONTEND,
  navigation: SURFACE_FRONTEND,
  weather: SURFACE_FRONTEND,
  flashbuy: SURFACE_BACKEND,
  'custom-skills': SURFACE_BACKEND,
})

const VALID_SURFACES = new Set([SURFACE_FRONTEND, SURFACE_BACKEND])

function parseRoutingConfig(source) {
  if (!source) {
    return JSON.parse(readFileSync(COCKPIT_SURFACE_ROUTING_URL, 'utf8'))
  }
  if (typeof source === 'object') return source
  const text = String(source).trim()
  if (!text) return {}
  if (text.startsWith('{')) return JSON.parse(text)
  return JSON.parse(readFileSync(text, 'utf8'))
}

function routingSource() {
  return process.env.COCKPIT_DOMAIN_SURFACES
    || process.env.COCKPIT_TOOL_SURFACE_ROUTING
    || ''
}

function normalizedDomains(rawConfig, groups) {
  const groupNames = new Set(groups.map(group => group.name))
  const configured = rawConfig?.domains || rawConfig || {}
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new TypeError('Cockpit surface routing domains must be an object')
  }
  const unknown = Object.keys(configured).filter(name => !groupNames.has(name))
  if (unknown.length) {
    throw new Error(`Unknown cockpit surface routing domains: ${unknown.join(', ')}`)
  }
  const domains = { ...DEFAULT_COCKPIT_DOMAIN_SURFACES, ...configured }
  const missing = groups.map(group => group.name).filter(name => !domains[name])
  if (missing.length) {
    throw new Error(`Missing cockpit surface routing domains: ${missing.join(', ')}`)
  }
  for (const [domain, surface] of Object.entries(domains)) {
    if (!groupNames.has(domain)) continue
    if (!VALID_SURFACES.has(surface)) {
      throw new Error(`Invalid cockpit surface for ${domain}: ${surface}`)
    }
  }
  return Object.freeze(Object.fromEntries(
    groups.map(group => [group.name, domains[group.name]]),
  ))
}

export function loadCockpitSurfaceRouting({ groups, source = routingSource() } = {}) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError('Cockpit surface routing requires tool groups')
  }
  const domains = normalizedDomains(parseRoutingConfig(source), groups)
  const entries = groups.flatMap(group => (
    group.definitions.map(tool => [tool.name, domains[group.name]])
  ))
  const toolSurfaceEntries = Object.freeze(entries.map(([name, surface]) => Object.freeze({
    name,
    surface,
  })))
  const toolSurfaceByName = new Map(entries)
  const toolNamesFor = surface => Object.freeze(
    entries
      .filter(([, value]) => value === surface)
      .map(([name]) => name),
  )

  return Object.freeze({
    domains,
    toolSurfaceEntries,
    frontendToolNames: toolNamesFor(SURFACE_FRONTEND),
    backendToolNames: toolNamesFor(SURFACE_BACKEND),
    surfaceForTool(name) {
      return toolSurfaceByName.get(name) || null
    },
  })
}
