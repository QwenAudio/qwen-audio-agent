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
} from '../../../server/src/frontend/frontend-tools.mjs'

test('routes complete cockpit domains to a single configured surface', () => {
  assert.deepEqual(COCKPIT_SURFACE_ROUTING.domains, {
    vehicle: 'frontend',
    navigation: 'frontend',
    music: 'frontend',
    weather: 'frontend',
    flashbuy: 'backend',
    'custom-skills': 'frontend',
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
  // The default Gateway supplies memory; a bare registry context does not.
  const defaultRealtimeTotal = frontendTools({ frontend: { capabilities: ['memory'] } }).length
    + FRONTEND_TOOL_NAMES.length
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
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /后台执行的领域：闪购/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /前台执行的领域：车控、导航、音乐、天气、自定义座舱技能/u)

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

test('limits completed route speech to distance and duration across scene tool descriptions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../service/tools/navigation/manifest.json', import.meta.url), 'utf8'))
  const config = JSON.parse(readFileSync(new URL('../gateway/frontend-mcp.json', import.meta.url), 'utf8'))
  const names = [
    'navigation_start', 'navigation_route_query', 'navigation_add_waypoint', 'navigation_remove_waypoint',
    'navigation_change_destination', 'navigation_set_route_strategy', 'navigation_to_favorite',
  ]
  const descriptions = names.flatMap(name => [
    manifest.functions.find(tool => tool.name === name).description,
    config.servers.cockpit.tools[name].description,
  ])
  for (const description of [...descriptions, COCKPIT_SPAWN_THINKING_DESCRIPTION]) {
    assert.match(description, /路线规划或重规划成功后/u)
    assert.match(description, /最终语音回复只播报总里程和预计耗时/u)
    assert.match(description, /不复述目的地或途经点/u)
    assert.match(description, /不要从结构化结果补读地点列表/u)
    assert.match(description, /用户明确询问路线详情时再展开/u)
    assert.match(description, /失败或未完成需如实说明/u)
  }
})

test('allows places during route planning while keeping one short preamble and backend acceptance', () => {
  const manifest = JSON.parse(readFileSync(new URL('../service/tools/navigation/manifest.json', import.meta.url), 'utf8'))
  const config = JSON.parse(readFileSync(new URL('../gateway/frontend-mcp.json', import.meta.url), 'utf8'))
  const names = [
    'navigation_start', 'navigation_route_query', 'navigation_add_waypoint',
    'navigation_remove_waypoint', 'navigation_change_destination',
    'navigation_set_route_strategy', 'navigation_to_favorite',
  ]
  for (const name of names) {
    for (const description of [
      manifest.functions.find(tool => tool.name === name).description,
      config.servers.cockpit.tools[name].description,
    ]) {
      assert.match(description, /作为前台工具使用且意图明确、信息齐全、需要规划或重规划路线时/u)
      assert.match(description, /调用前先用一句简短自然口语/u)
      assert.match(description, /规划过程中可以复述地点列表/u)
      assert.doesNotMatch(description, /约10字|不复述地点列表/u)
      assert.match(description, /随后在同一轮立即调用工具/u)
      assert.match(description, /同一请求只衔接一次，不固定话术，不等待再次确认/u)
      assert.match(description, /不以口头回应代替执行，也不把尚未完成说成成功/u)
    }
  }
  assert.doesNotMatch(COCKPIT_SPAWN_THINKING_DESCRIPTION, /调用前先/u)
  assert.match(COCKPIT_SPAWN_THINKING_DESCRIPTION, /工作受理后只作一次/u)
  assert.doesNotMatch(config.servers.cockpit.tools.navigation_stop.description, /调用前先/u)
  assert.doesNotMatch(config.servers.cockpit.tools.vehicle_window_control.description, /调用前先/u)
  assert.match(config.servers.cockpit.tools.navigation_route_query.description,
    /不带 destination 查询当前路线时，按用户问题提供路线详情/u)
})

test('keeps preference-based nearby recommendations grounded in actual POIs on both tool surfaces', () => {
  const manifest = JSON.parse(readFileSync(new URL('../service/tools/navigation/manifest.json', import.meta.url), 'utf8'))
  const config = JSON.parse(readFileSync(new URL('../gateway/frontend-mcp.json', import.meta.url), 'utf8'))
  const search = manifest.functions.find(tool => tool.name === 'navigation_search_place')
  for (const description of [search.description, config.servers.cockpit.tools.navigation_search_place.description]) {
    assert.match(description, /当前请求和已知饮食偏好/u)
    assert.match(description, /已有相关偏好就必须落实到 query/u)
    assert.match(description, /不编造菜品、环境、评分或口味匹配依据/u)
    assert.match(description, /nearby=true/u)
    assert.match(description, /不把口味要求拼成店名或目的地/u)
    assert.match(description, /只推荐返回的真实店名/u)
    assert.match(description, /没有菜品依据时不保证辣度/u)
    assert.match(description, /只有用户明确要求前往/u)
  }
  assert.match(search.parameters.properties.query.description, /不拼入不辣/u)
  assert.match(search.parameters.properties.category.description, /不是供应商分类码/u)
})
