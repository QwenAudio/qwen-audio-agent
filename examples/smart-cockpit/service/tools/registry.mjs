import { readFileSync } from 'node:fs'
import { executeCustomSkillTool } from './custom-skills/execute.mjs'
import { executeFlashbuyTool } from './flashbuy/execute.mjs'
import { executeMusicTool } from './music/execute.mjs'
import { executeNavigationTool } from './navigation/execute.mjs'
import { executeVehicleTool } from './vehicle/execute.mjs'
import { executeWeatherTool } from './weather/execute.mjs'
import { loadCockpitSurfaceRouting } from './surface-routing.mjs'

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
        'custom_skill_list',
        'custom_skill_load',
        'vehicle_location_query',
        'vehicle_state_query',
        'navigation_route_query',
        'navigation_search_place',
        'music_state_query',
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
const customSkills = toolGroup('custom-skills', executeCustomSkillTool)

export const COCKPIT_TOOL_GROUPS = Object.freeze([
  vehicle,
  navigation,
  music,
  weather,
  flashbuy,
  customSkills,
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

// Tool implementation stays grouped by business domain. Surface routing is the
// scenario customization point: each domain is exposed either to the foreground
// low-latency MCP surface or to the backend orchestration MCP surface.
export const COCKPIT_SURFACE_ROUTING = loadCockpitSurfaceRouting({
  groups: COCKPIT_TOOL_GROUPS,
})
const toolDefinitionsByName = new Map(
  COCKPIT_TOOL_DEFINITIONS.map(tool => [tool.name, tool]),
)
const definitionsForNames = names => Object.freeze(
  names.map(name => {
    const definitionForName = toolDefinitionsByName.get(name)
    if (!definitionForName) throw new Error(`Unknown cockpit tool in surface routing: ${name}`)
    return definitionForName
  }),
)

export const FRONTEND_TOOL_NAMES = COCKPIT_SURFACE_ROUTING.frontendToolNames
export const BACKEND_TOOL_NAMES = COCKPIT_SURFACE_ROUTING.backendToolNames
export const FRONTEND_TOOL_DEFINITIONS = Object.freeze(
  definitionsForNames(FRONTEND_TOOL_NAMES),
)
export const BACKEND_TOOL_DEFINITIONS = Object.freeze(
  definitionsForNames(BACKEND_TOOL_NAMES),
)
export const COCKPIT_TOOL_SURFACE_ENTRIES = COCKPIT_SURFACE_ROUTING.toolSurfaceEntries

export function surfaceForCockpitTool(name) {
  return COCKPIT_SURFACE_ROUTING.surfaceForTool(name)
}

const EXECUTORS = new Map(COCKPIT_TOOL_GROUPS.flatMap(group => (
  group.definitions.map(tool => [tool.name, group.execute])
)))

export function executeCockpitTool(name, args, context) {
  const execute = EXECUTORS.get(name)
  if (!execute) throw new Error(`Unknown cockpit tool: ${name}`)
  return execute(name, args, context)
}
