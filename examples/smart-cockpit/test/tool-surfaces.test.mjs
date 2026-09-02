import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BACKEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_DEFINITIONS,
} from '../service/tools/registry.mjs'
import { COCKPIT_SPAWN_THINKING_DESCRIPTION } from '../gateway/spawn-thinking-tool.mjs'

test('adds a foreground fast path while retaining a complete backend orchestration surface', () => {
  assert.deepEqual(FRONTEND_TOOL_DEFINITIONS.map(tool => tool.name), [
    'weather',
    'vehicle_location_query',
    'vehicle_state_query',
    'vehicle_window_control',
    'vehicle_sunroof_control',
    'vehicle_headlights_control',
    'vehicle_climate_control',
    'navigation_set_route_strategy',
    'navigation_set_voice',
    'navigation_set_view',
    'navigation_stop',
    'music_pause',
    'music_next',
    'music_previous',
  ])
  assert.equal(BACKEND_TOOL_DEFINITIONS.length, 28)
  const backendNames = BACKEND_TOOL_DEFINITIONS.map(tool => tool.name)
  assert.ok(backendNames.includes('vehicle_sunroof_control'))
  assert.ok(backendNames.includes('vehicle_climate_control'))
  assert.ok(backendNames.includes('navigation_set_route_strategy'))
  assert.ok(backendNames.includes('navigation_set_view'))
  assert.ok(backendNames.includes('weather'))
  assert.ok(backendNames.includes('vehicle_window_control'))
  assert.ok(backendNames.includes('vehicle_headlights_control'))
  assert.ok(backendNames.includes('vehicle_location_query'))
  assert.ok(backendNames.includes('custom_skill_list'))
  assert.ok(backendNames.includes('custom_skill_create'))
  assert.ok(backendNames.includes('custom_skill_load'))
})

test('binds the cockpit frontend profile to the scoped MCP configuration', () => {
  const profileUrl = new URL('../gateway/frontend-profile.json', import.meta.url)
  const profile = JSON.parse(readFileSync(
    profileUrl,
    'utf8',
  ))
  const config = JSON.parse(readFileSync(
    new URL(profile.toolSources.mcp, profileUrl),
    'utf8',
  ))
  assert.equal(profile.toolSources.mcp, 'frontend-mcp.json')
  assert.equal(config.servers.cockpit.url, '${COCKPIT_FRONTEND_MCP_URL}')
  assert.deepEqual(Object.keys(config.servers.cockpit.tools), [
    'weather',
    'vehicle_location_query',
    'vehicle_state_query',
    'vehicle_window_control',
    'vehicle_sunroof_control',
    'vehicle_headlights_control',
    'vehicle_climate_control',
    'navigation_set_route_strategy',
    'navigation_set_voice',
    'navigation_set_view',
    'navigation_stop',
    'music_pause',
    'music_next',
    'music_previous',
  ])
  assert.equal(config.servers.cockpit.tools.vehicle_window_control.enabled, true)
  assert.equal(config.servers.cockpit.tools.navigation_set_view.enabled, true)
  assert.equal(config.servers.cockpit.tools.vehicle_location_query.enabled, true)
  assert.equal(config.servers.cockpit.tools.navigation_stop.enabled, true)
  assert.ok(!('approval' in config.servers.cockpit.tools.vehicle_window_control))
  assert.equal(config.servers.cockpit.tools.vehicle_climate_control.enabled, true)
  assert.ok(!('approval' in config.servers.cockpit.tools.vehicle_climate_control))
})

test('keeps asynchronous cockpit acknowledgements natural and action-specific', () => {
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不说“好的，已为你提交”/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不提“提交”“已受理”“后台”“任务”/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /与当前动作相关/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不固定话术/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /忠实保留用户选定的商品和当前动作/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不要把加购改写为搜索/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /导航视图、导航播报、当前路线偏好/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /停止导航/u)

  const frontendConfig = JSON.parse(readFileSync(
    new URL('../gateway/frontend-mcp.json', import.meta.url),
    'utf8',
  ))
  const navigationViewDescription = frontendConfig.servers.cockpit.tools.navigation_set_view.description
  assert.match(navigationViewDescription, /直接调用/u)
  assert.match(navigationViewDescription, /不要只口头回应/u)
  assert.match(
    frontendConfig.servers.cockpit.tools.navigation_set_route_strategy.description,
    /躲避拥堵/u,
  )
})
