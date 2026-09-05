import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BACKEND_TOOL_DEFINITIONS,
  BACKEND_TOOL_NAMES,
  COCKPIT_SURFACE_ROUTING,
  COCKPIT_TOOL_GROUPS,
  FRONTEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_NAMES,
} from '../service/tools/registry.mjs'
import { loadCockpitSurfaceRouting } from '../service/tools/surface-routing.mjs'
import { COCKPIT_SPAWN_THINKING_DESCRIPTION } from '../gateway/spawn-thinking-tool.mjs'
import {
  frontendToolRegistry,
  frontendTools,
} from '../../../server/src/voice/frontend-tools.mjs'

test('routes complete cockpit domains to a single configured surface', () => {
  assert.deepEqual(COCKPIT_SURFACE_ROUTING.domains, {
    vehicle: 'frontend',
    navigation: 'frontend',
    music: 'frontend',
    weather: 'frontend',
    flashbuy: 'backend',
    'custom-skills': 'backend',
  })
  assert.equal(FRONTEND_TOOL_DEFINITIONS.length, FRONTEND_TOOL_NAMES.length)
  assert.equal(BACKEND_TOOL_DEFINITIONS.length, BACKEND_TOOL_NAMES.length)

  const frontendNames = new Set(FRONTEND_TOOL_NAMES)
  const backendNames = new Set(BACKEND_TOOL_NAMES)
  for (const group of COCKPIT_TOOL_GROUPS) {
    const expectedSet = COCKPIT_SURFACE_ROUTING.domains[group.name] === 'frontend'
      ? frontendNames
      : backendNames
    const otherSet = expectedSet === frontendNames ? backendNames : frontendNames
    for (const tool of group.definitions) {
      assert.equal(expectedSet.has(tool.name), true, `${tool.name} should be routed to ${expectedSet === frontendNames ? 'frontend' : 'backend'}`)
      assert.equal(otherSet.has(tool.name), false, `${tool.name} should not be exposed on both surfaces`)
    }
  }
})

test('can move an entire domain between surfaces with one routing override', () => {
  const routing = loadCockpitSurfaceRouting({
    groups: COCKPIT_TOOL_GROUPS,
    source: { domains: { navigation: 'backend' } },
  })
  const navigationTools = COCKPIT_TOOL_GROUPS
    .find(group => group.name === 'navigation')
    .definitions
    .map(tool => tool.name)
  assert.equal(routing.surfaceForTool('navigation_start'), 'backend')
  assert.equal(routing.surfaceForTool('navigation_stop'), 'backend')
  assert.ok(navigationTools.every(name => routing.backendToolNames.includes(name)))
  assert.ok(navigationTools.every(name => !routing.frontendToolNames.includes(name)))
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
  assert.deepEqual(
    new Set(Object.keys(config.servers.cockpit.tools)),
    new Set(FRONTEND_TOOL_NAMES),
  )
  assert.equal(config.servers.cockpit.tools.vehicle_window_control.enabled, true)
  assert.equal(config.servers.cockpit.tools.vehicle_location_query.enabled, true)
  assert.equal(config.servers.cockpit.tools.navigation_stop.enabled, true)
  assert.ok(!('approval' in config.servers.cockpit.tools.vehicle_window_control))
  assert.equal(config.servers.cockpit.tools.vehicle_climate_control.enabled, true)
  assert.ok(!('approval' in config.servers.cockpit.tools.vehicle_climate_control))
  assert.equal(config.servers.cockpit.tools.vehicle_charging_control.enabled, true)
  assert.equal(config.servers.cockpit.tools.music_state_query.enabled, true)
  assert.match(config.servers.cockpit.tools.music_state_query.description, /不要把查询当成控制/u)
  assert.match(config.servers.cockpit.tools.music_search.description, /不自动播放/u)
  assert.match(config.servers.cockpit.tools.music_volume_control.description, /直接调用/u)
})

test('documents the Gateway function tools exposed around cockpit MCP tools', () => {
  const readmes = [
    readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../README_ZH.md', import.meta.url), 'utf8'),
  ]
  for (const name of frontendToolRegistry.names()) {
    for (const readme of readmes) {
      assert.match(readme, new RegExp(`\`${name}\``))
    }
  }
  const defaultRealtimeTotal = frontendTools({}).length + FRONTEND_TOOL_NAMES.length
  for (const readme of readmes) {
    assert.match(readme, new RegExp(`\\*\\*${defaultRealtimeTotal}\\*\\*`))
    assert.match(readme, new RegExp(`\\b${FRONTEND_TOOL_NAMES.length}\\b`))
  }
})

test('keeps asynchronous cockpit acknowledgements natural and action-specific', () => {
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不说“好的，已为你提交”/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不提“提交”“已受理”“后台”“任务”/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /与当前动作相关/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不固定话术/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /忠实保留用户选定的商品和当前动作/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /不要把加购改写为搜索/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /后台执行的领域：闪购、自定义座舱技能/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /前台执行的领域：车控、导航、音乐、天气/u)

  const frontendConfig = JSON.parse(readFileSync(
    new URL('../gateway/frontend-mcp.json', import.meta.url),
    'utf8',
  ))
  assert.match(
    frontendConfig.servers.cockpit.tools.vehicle_window_control.description,
    /立即打开、关闭/u,
  )

  const navigationManifest = JSON.parse(readFileSync(
    new URL('../service/tools/navigation/manifest.json', import.meta.url),
    'utf8',
  ))
  const addWaypoint = navigationManifest.functions.find(tool => tool.name === 'navigation_add_waypoint')
  assert.match(addWaypoint.description, /已有当前导航或路线预览/u)
  assert.match(addWaypoint.description, /必须先追问最终要去哪里/u)
  assert.match(addWaypoint.description, /不要调用本工具探测状态/u)
})
