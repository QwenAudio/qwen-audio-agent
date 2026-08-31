import { readFileSync } from 'node:fs'

const DOMAIN_FILES = [
  'vehicle',
  'navigation',
  'music',
  'weather',
  'flashbuy',
]

function loadDomain(name) {
  const url = new URL(`../server/domains/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8'))
}

export const COCKPIT_TOOL_DEFINITIONS = Object.freeze(
  DOMAIN_FILES.flatMap(name => loadDomain(name).functions)
    .filter(tool => tool.enabled !== false)
    .map(tool => Object.freeze({
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: {
        readOnlyHint: [
          'vehicle_state_query',
          'navigation_route_query',
          'music_search',
          'weather',
        ].includes(tool.name),
        openWorldHint: ['navigation_start', 'navigation_route_query', 'weather'].includes(tool.name),
        destructiveHint: tool.name === 'flashbuy',
      },
    })),
)

export const COCKPIT_TOOL_NAMES = Object.freeze(
  COCKPIT_TOOL_DEFINITIONS.map(tool => tool.name),
)
