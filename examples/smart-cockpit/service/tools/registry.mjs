import { readFileSync } from 'node:fs'
import { executeFlashbuyTool } from './flashbuy/execute.mjs'
import { executeMusicTool } from './music/execute.mjs'
import { executeNavigationTool } from './navigation/execute.mjs'
import { executeVehicleTool } from './vehicle/execute.mjs'
import { executeWeatherTool } from './weather/execute.mjs'

function loadManifest(name) {
  return JSON.parse(readFileSync(new URL(`./${name}/manifest.json`, import.meta.url), 'utf8'))
}

function definition(tool) {
  return Object.freeze({
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
  })
}

function toolGroup(name, execute) {
  const manifest = Object.freeze(loadManifest(name))
  if (manifest.domain !== name || !Array.isArray(manifest.functions)) {
    throw new Error(`Invalid cockpit tool group manifest: ${name}`)
  }
  if (typeof execute !== 'function') {
    throw new TypeError(`Cockpit tool group ${name} requires an executor`)
  }
  return Object.freeze({
    name,
    manifest,
    definitions: Object.freeze(
      manifest.functions
        .filter(tool => tool.enabled !== false)
        .map(definition),
    ),
    execute,
  })
}

const vehicle = toolGroup('vehicle', executeVehicleTool)
const navigation = toolGroup('navigation', executeNavigationTool)
const music = toolGroup('music', executeMusicTool)
const weather = toolGroup('weather', executeWeatherTool)
const flashbuy = toolGroup('flashbuy', executeFlashbuyTool)

// This explicit composition is the scenario customization point. It keeps the
// MCP contract standard without introducing a dynamic plugin framework.
export const FRONTEND_TOOL_GROUPS = Object.freeze([weather])
export const BACKEND_TOOL_GROUPS = Object.freeze([
  vehicle,
  navigation,
  music,
  flashbuy,
])
export const COCKPIT_TOOL_GROUPS = Object.freeze([
  ...FRONTEND_TOOL_GROUPS,
  ...BACKEND_TOOL_GROUPS,
])

function definitions(groups) {
  return Object.freeze(groups.flatMap(group => group.definitions))
}

export const FRONTEND_TOOL_DEFINITIONS = definitions(FRONTEND_TOOL_GROUPS)
export const BACKEND_TOOL_DEFINITIONS = definitions(BACKEND_TOOL_GROUPS)
export const COCKPIT_TOOL_DEFINITIONS = definitions(COCKPIT_TOOL_GROUPS)
export const COCKPIT_TOOL_NAMES = Object.freeze(
  COCKPIT_TOOL_DEFINITIONS.map(tool => tool.name),
)

if (new Set(COCKPIT_TOOL_NAMES).size !== COCKPIT_TOOL_NAMES.length) {
  throw new Error('Cockpit tool names must be unique across groups')
}

const EXECUTORS = new Map(COCKPIT_TOOL_GROUPS.flatMap(group => (
  group.definitions.map(tool => [tool.name, group.execute])
)))

export function executeCockpitTool(name, args, context) {
  const execute = EXECUTORS.get(name)
  if (!execute) throw new Error(`Unknown cockpit tool: ${name}`)
  return execute(name, args, context)
}
