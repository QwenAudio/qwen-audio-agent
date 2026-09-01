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
        'navigation_search_place',
        'music_search',
        'weather',
      ].includes(tool.name),
      openWorldHint: [
        'navigation_start',
        'navigation_route_query',
        'navigation_add_waypoint',
        'navigation_change_destination',
        'navigation_set_route_strategy',
        'navigation_search_place',
        'navigation_to_favorite',
        'navigation_set_favorite',
        'weather',
      ].includes(tool.name),
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

export const COCKPIT_TOOL_GROUPS = Object.freeze([
  vehicle,
  navigation,
  music,
  weather,
  flashbuy,
])

function definitions(groups) {
  return Object.freeze(groups.flatMap(group => group.definitions))
}

export const COCKPIT_TOOL_DEFINITIONS = definitions(COCKPIT_TOOL_GROUPS)
export const COCKPIT_TOOL_NAMES = Object.freeze(
  COCKPIT_TOOL_DEFINITIONS.map(tool => tool.name),
)

if (new Set(COCKPIT_TOOL_NAMES).size !== COCKPIT_TOOL_NAMES.length) {
  throw new Error('Cockpit tool names must be unique across groups')
}

// Tool implementation stays grouped by business domain. This explicit surface
// assignment is the scenario customization point: simple low-latency actions
// run inline in the foreground, while orchestrated work stays with the backend
// Agent. It keeps one executor per capability without a dynamic plugin layer.
export const FRONTEND_TOOL_NAMES = Object.freeze([
  'weather',
  'vehicle_state_query',
  'vehicle_window_control',
  'vehicle_headlights_control',
  'navigation_set_route_strategy',
  'navigation_set_voice',
  'navigation_set_view',
])

const BACKEND_EXCLUDED_TOOL_NAMES = new Set([
  'weather',
  'vehicle_state_query',
  'vehicle_window_control',
  'vehicle_headlights_control',
])

const toolDefinitionsByName = new Map(
  COCKPIT_TOOL_DEFINITIONS.map(tool => [tool.name, tool]),
)
const frontendNames = new Set(FRONTEND_TOOL_NAMES)
const unknownFrontendNames = FRONTEND_TOOL_NAMES.filter(
  name => !toolDefinitionsByName.has(name),
)
if (unknownFrontendNames.length) {
  throw new Error(`Unknown frontend cockpit tools: ${unknownFrontendNames.join(', ')}`)
}

export const FRONTEND_TOOL_DEFINITIONS = Object.freeze(
  FRONTEND_TOOL_NAMES.map(name => toolDefinitionsByName.get(name)),
)
export const BACKEND_TOOL_DEFINITIONS = Object.freeze(
  COCKPIT_TOOL_DEFINITIONS.filter(tool => !BACKEND_EXCLUDED_TOOL_NAMES.has(tool.name)),
)

const EXECUTORS = new Map(COCKPIT_TOOL_GROUPS.flatMap(group => (
  group.definitions.map(tool => [tool.name, group.execute])
)))

export function executeCockpitTool(name, args, context) {
  const execute = EXECUTORS.get(name)
  if (!execute) throw new Error(`Unknown cockpit tool: ${name}`)
  return execute(name, args, context)
}
