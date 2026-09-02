import { DEFAULT_ORIGIN } from './catalog.mjs'
import { clean, reportActivity, toolResult } from '../shared.mjs'

const MAX_WAYPOINTS = 8
const VALID_STRATEGIES = new Set([0, 13, 5, 4, 11, 14, 2])
const VALID_VOICE_MODES = new Set(['standard', 'detailed', 'brief'])
const VALID_VIEW_MODES = new Set(['follow', 'overview', 'north_up'])
const STRATEGY_LABELS = new Map([
  [0, '智能推荐'],
  [13, '高速优先'],
  [5, '不走高速'],
  [4, '躲避拥堵'],
  [11, '少收费'],
  [14, '大路优先'],
  [2, '时间优先'],
])
const FAVORITE_LABELS = {
  home: '家',
  office: '公司',
  school: '学校',
  custom: '常用地点',
}

function normalizeStrategy(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback
  const strategy = Number(value)
  return VALID_STRATEGIES.has(strategy) ? strategy : fallback
}

function currentOrigin(state) {
  return state.location?.coordinates || DEFAULT_ORIGIN.location
}

function activeNavigation(state) {
  const navigation = state.navigation || {}
  return navigation.status !== 'idle' && Boolean(navigation.destination)
}

function routeStatusText(status) {
  return status === 'navigating' ? '导航' : '规划'
}

function markerLocation(navigation, role, index = null) {
  return (navigation.map?.markers || []).find(marker => (
    marker.role === role && (index === null || marker.index === index)
  ))?.location || null
}

function knownDestinationLocation(navigation) {
  return navigation.destinationLocation || markerLocation(navigation, 'destination')
}

function knownWaypointLocations(navigation) {
  if (Array.isArray(navigation.waypointLocations) && navigation.waypointLocations.length) {
    return [...navigation.waypointLocations]
  }
  return (navigation.waypoints || []).map((_, index) => (
    markerLocation(navigation, 'waypoint', index)
  ))
}

async function resolvePlace(name, city, services) {
  return services.resolvePlace(clean(name), city)
}

async function resolveExistingRouteLocations(navigation, services) {
  let destinationLocation = knownDestinationLocation(navigation)
  if (!destinationLocation && navigation.destination) {
    destinationLocation = await resolvePlace(navigation.destination, DEFAULT_ORIGIN.city, services)
  }
  const waypointLocations = knownWaypointLocations(navigation)
  const resolvedWaypoints = []
  for (let index = 0; index < (navigation.waypoints || []).length; index += 1) {
    resolvedWaypoints.push(
      waypointLocations[index]
        || await resolvePlace(navigation.waypoints[index], DEFAULT_ORIGIN.city, services),
    )
  }
  if (!destinationLocation || resolvedWaypoints.some(location => !location)) return null
  return { destinationLocation, waypointLocations: resolvedWaypoints }
}

async function planRoute(origin, destination, waypoints, strategy, { now, services }) {
  const stops = [origin, ...waypoints, destination]
  const legs = []
  for (let index = 1; index < stops.length; index += 1) {
    const leg = await services.drivingRoute(stops[index - 1], stops[index], strategy)
    if (!leg) return null
    legs.push(leg)
  }
  const distance = legs.reduce((total, leg) => total + Number(leg.distance || 0), 0)
  const duration = legs.reduce((total, leg) => total + Number(leg.duration || 0), 0)
  const arrival = new Date(now() + duration * 1_000)
  return {
    distance,
    duration,
    distKm: (distance / 1_000).toFixed(1),
    durationMin: Math.ceil(duration / 60),
    arrival: `${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')}`,
    legs: structuredClone(legs),
  }
}

function buildNavigationMap(destination, destinationLocation, waypoints, waypointLocations, route) {
  return {
    markers: [
      { role: 'destination', name: destination, location: destinationLocation },
      ...waypoints.map((name, index) => ({
        role: 'waypoint',
        index,
        name,
        location: waypointLocations[index],
      })),
    ],
    polylines: route.legs.map((leg, index) => ({
      segment: index,
      polyline: leg.polyline,
      trafficSegments: leg.trafficSegments || [],
    })),
  }
}

function commitRoute(store, cockpitId, {
  status,
  destination,
  destinationLocation,
  waypoints,
  waypointLocations,
  strategy,
  route,
}) {
  return store.update(cockpitId, ['navigation'], next => {
    next.navigation = {
      ...next.navigation,
      status,
      destination,
      destinationLocation,
      waypoints,
      waypointLocations,
      strategy,
      route,
      map: buildNavigationMap(destination, destinationLocation, waypoints, waypointLocations, route),
    }
  })
}

function routeContent(prefix, destination, waypoints, route, strategy = null) {
  const waypointText = waypoints.length ? `，途经${waypoints.join('、')}` : ''
  const strategyText = strategy === null ? '' : `，${STRATEGY_LABELS.get(strategy) || '已更新偏好'}`
  return `${prefix}${destination}${waypointText}${strategyText}，全程${route.distKm}公里，约${route.durationMin}分钟`
}

async function createRoutePlan({
  name,
  status,
  destination,
  waypoints,
  strategy,
  context,
}) {
  const { cockpitId, onActivity, services, snapshot, store } = context
  const origin = currentOrigin(snapshot())
  reportActivity(onActivity, 'navigation', 'searching_destination', '正在查找目的地')
  const destinationLocation = await resolvePlace(destination, DEFAULT_ORIGIN.city, services)
  if (!destinationLocation) {
    reportActivity(onActivity, 'navigation', 'destination_not_found', `没有找到${destination}`)
    return toolResult(`无法找到“${destination}”的位置信息`, snapshot(), [])
  }
  reportActivity(onActivity, 'navigation', 'destination_locked', `已找到${destination}`)
  const waypointLocations = []
  for (const waypoint of waypoints) {
    reportActivity(onActivity, 'navigation', 'searching_waypoint', `正在查找途经点${waypoint}`)
    const location = await resolvePlace(waypoint, DEFAULT_ORIGIN.city, services)
    if (!location) {
      reportActivity(onActivity, 'navigation', 'waypoint_not_found', `没有找到${waypoint}`)
      return toolResult(`无法找到途经点“${waypoint}”的位置信息`, snapshot(), [])
    }
    waypointLocations.push(location)
    reportActivity(onActivity, 'navigation', 'waypoint_locked', `已找到途经点${waypoint}`)
  }
  reportActivity(onActivity, 'navigation', 'planning_route', '正在规划路线')
  const route = await planRoute(origin, destinationLocation, waypointLocations, strategy, context)
  if (!route) {
    reportActivity(onActivity, 'navigation', 'route_failed', '路线规划失败')
    return toolResult('路线规划失败，请稍后重试', snapshot(), [])
  }
  const state = commitRoute(store, cockpitId, {
    status,
    destination,
    destinationLocation,
    waypoints,
    waypointLocations,
    strategy,
    route,
  })
  const activityStatus = name === 'navigation_start' ? 'navigation_started' : 'route_ready'
  reportActivity(onActivity, 'navigation', activityStatus, name === 'navigation_start' ? '开始导航' : '路线规划好了')
  const prefix = name === 'navigation_start' ? '已开始导航到' : '已规划到'
  return toolResult(
    routeContent(prefix, destination, waypoints, route),
    state,
    ['navigation'],
    { navigation: state.navigation },
  )
}

async function replanExistingRoute({
  context,
  status,
  destination,
  destinationLocation,
  waypoints,
  waypointLocations,
  strategy,
  planningMessage = '正在重新规划路线',
}) {
  const { cockpitId, onActivity, snapshot, store } = context
  reportActivity(onActivity, 'navigation', 'planning_route', planningMessage)
  const route = await planRoute(currentOrigin(snapshot()), destinationLocation, waypointLocations, strategy, context)
  if (!route) {
    reportActivity(onActivity, 'navigation', 'route_failed', '路线规划失败')
    return toolResult('路线规划失败，请稍后重试', snapshot(), [])
  }
  const state = commitRoute(store, cockpitId, {
    status,
    destination,
    destinationLocation,
    waypoints,
    waypointLocations,
    strategy,
    route,
  })
  reportActivity(onActivity, 'navigation', 'route_ready', '路线已更新')
  return { state, route }
}

async function addWaypoint(args, context) {
  const { onActivity, services, snapshot } = context
  const state = snapshot()
  if (!activeNavigation(state)) {
    return toolResult('当前没有进行中的导航，请先告诉我要去哪里', state, [], {
      navigation: state.navigation,
    })
  }
  const waypoint = clean(args.waypoint)
  if (!waypoint) return toolResult('请告诉我要增加哪个途经点', state, [], { navigation: state.navigation })
  const existing = await resolveExistingRouteLocations(state.navigation, services)
  if (!existing) return toolResult('当前路线信息不完整，请重新发起导航', state, [], { navigation: state.navigation })

  reportActivity(onActivity, 'navigation', 'searching_waypoint', `正在查找途经点${waypoint}`)
  const waypointLocation = await resolvePlace(waypoint, DEFAULT_ORIGIN.city, services)
  if (!waypointLocation) {
    reportActivity(onActivity, 'navigation', 'waypoint_not_found', `没有找到${waypoint}`)
    return toolResult(`无法找到途经点“${waypoint}”的位置信息`, snapshot(), [])
  }
  reportActivity(onActivity, 'navigation', 'waypoint_locked', `已找到途经点${waypoint}`)
  const insertIndex = args.insertPosition === 'before_destination' ? state.navigation.waypoints.length : 0
  const waypoints = [...state.navigation.waypoints]
  const waypointLocations = [...existing.waypointLocations]
  waypoints.splice(insertIndex, 0, waypoint)
  waypointLocations.splice(insertIndex, 0, waypointLocation)
  const strategy = normalizeStrategy(args.strategy, state.navigation.strategy)
  const output = await replanExistingRoute({
    context,
    status: state.navigation.status,
    destination: state.navigation.destination,
    destinationLocation: existing.destinationLocation,
    waypoints,
    waypointLocations,
    strategy,
  })
  if (output.content) return output
  return toolResult(
    routeContent(`已增加途经点${waypoint}，继续${routeStatusText(output.state.navigation.status)}到`, output.state.navigation.destination, waypoints, output.route),
    output.state,
    ['navigation'],
    { navigation: output.state.navigation },
  )
}

async function removeWaypoint(args, context) {
  const { services, snapshot } = context
  const state = snapshot()
  if (!activeNavigation(state)) {
    return toolResult('当前没有进行中的导航，请先告诉我要去哪里', state, [], {
      navigation: state.navigation,
    })
  }
  if (!state.navigation.waypoints.length) {
    return toolResult('当前路线没有途经点', state, [], { navigation: state.navigation })
  }
  const waypointName = clean(args.waypoint)
  const requestedIndex = Number(args.index)
  const index = waypointName
    ? state.navigation.waypoints.findIndex(item => item === waypointName)
    : Number.isInteger(requestedIndex) ? requestedIndex - 1 : -1
  if (index < 0 || index >= state.navigation.waypoints.length) {
    return toolResult('没有找到要删除的途经点', state, [], { navigation: state.navigation })
  }
  const existing = await resolveExistingRouteLocations(state.navigation, services)
  if (!existing) return toolResult('当前路线信息不完整，请重新发起导航', state, [], { navigation: state.navigation })

  const removed = state.navigation.waypoints[index]
  const waypoints = state.navigation.waypoints.filter((_, itemIndex) => itemIndex !== index)
  const waypointLocations = existing.waypointLocations.filter((_, itemIndex) => itemIndex !== index)
  const output = await replanExistingRoute({
    context,
    status: state.navigation.status,
    destination: state.navigation.destination,
    destinationLocation: existing.destinationLocation,
    waypoints,
    waypointLocations,
    strategy: state.navigation.strategy,
  })
  if (output.content) return output
  return toolResult(
    routeContent(`已删除途经点${removed}，继续${routeStatusText(output.state.navigation.status)}到`, output.state.navigation.destination, waypoints, output.route),
    output.state,
    ['navigation'],
    { navigation: output.state.navigation },
  )
}

async function changeDestination(args, context) {
  const { onActivity, services, snapshot } = context
  const state = snapshot()
  if (!activeNavigation(state)) {
    return toolResult('当前没有进行中的导航，请先告诉我要去哪里', state, [], {
      navigation: state.navigation,
    })
  }
  const destination = clean(args.destination)
  if (!destination) return toolResult('请告诉我要把目的地改成哪里', state, [], { navigation: state.navigation })

  reportActivity(onActivity, 'navigation', 'searching_destination', '正在查找目的地')
  const destinationLocation = await resolvePlace(destination, DEFAULT_ORIGIN.city, services)
  if (!destinationLocation) {
    reportActivity(onActivity, 'navigation', 'destination_not_found', `没有找到${destination}`)
    return toolResult(`无法找到“${destination}”的位置信息`, snapshot(), [])
  }
  reportActivity(onActivity, 'navigation', 'destination_locked', `已找到${destination}`)
  const existing = await resolveExistingRouteLocations(state.navigation, services)
  if (!existing) return toolResult('当前路线信息不完整，请重新发起导航', state, [], { navigation: state.navigation })
  const strategy = normalizeStrategy(args.strategy, state.navigation.strategy)
  const output = await replanExistingRoute({
    context,
    status: state.navigation.status,
    destination,
    destinationLocation,
    waypoints: state.navigation.waypoints,
    waypointLocations: existing.waypointLocations,
    strategy,
  })
  if (output.content) return output
  return toolResult(
    routeContent('已将目的地改为', destination, output.state.navigation.waypoints, output.route),
    output.state,
    ['navigation'],
    { navigation: output.state.navigation },
  )
}

async function setRouteStrategy(args, context) {
  const { cockpitId, services, snapshot, store } = context
  const state = snapshot()
  const strategy = normalizeStrategy(args.strategy, null)
  if (strategy === null) return toolResult('请提供有效的路线偏好', state, [], { navigation: state.navigation })
  if (!activeNavigation(state)) {
    const nextState = store.update(cockpitId, ['navigation'], next => {
      next.navigation.strategy = strategy
    })
    return toolResult(
      `已将后续路线偏好设为${STRATEGY_LABELS.get(strategy)}`,
      nextState,
      ['navigation'],
      { navigation: nextState.navigation },
    )
  }
  const existing = await resolveExistingRouteLocations(state.navigation, services)
  if (!existing) return toolResult('当前路线信息不完整，请重新发起导航', state, [], { navigation: state.navigation })
  const output = await replanExistingRoute({
    context,
    status: state.navigation.status,
    destination: state.navigation.destination,
    destinationLocation: existing.destinationLocation,
    waypoints: state.navigation.waypoints,
    waypointLocations: existing.waypointLocations,
    strategy,
  })
  if (output.content) return output
  return toolResult(
    routeContent('已切换路线偏好，继续到', output.state.navigation.destination, output.state.navigation.waypoints, output.route, strategy),
    output.state,
    ['navigation'],
    { navigation: output.state.navigation },
  )
}

async function searchPlace(args, context) {
  const { onActivity, services, snapshot } = context
  const state = snapshot()
  const query = clean(args.query) || clean(args.category)
  if (!query) return toolResult('请告诉我要搜索什么地点', state, [], { results: [] })
  reportActivity(onActivity, 'navigation', 'place_searching', `正在搜索${query}`)
  const radius = Number(args.radius) > 0 ? Number(args.radius) : 3000
  let results = []
  if (args.nearby && typeof services.searchNearbyPlaces === 'function') {
    results = await services.searchNearbyPlaces({
      keywords: query,
      location: currentOrigin(state),
      radius,
    })
  } else if (typeof services.searchPlaces === 'function') {
    results = await services.searchPlaces(query, {
      city: DEFAULT_ORIGIN.city,
      types: clean(args.category),
    })
  }
  if (!results.length) {
    const location = await resolvePlace(query, DEFAULT_ORIGIN.city, services)
    if (location) results = [{ name: query, location }]
  }
  reportActivity(onActivity, 'navigation', 'place_results_ready', results.length ? '地点搜索完成' : '没有找到相关地点')
  const content = results.length
    ? `找到${results.length}个地点：${results.slice(0, 3).map(item => item.name || item.location).join('、')}`
    : `没有找到“${query}”相关地点`
  return toolResult(content, state, [], { results })
}

async function navigateToFavorite(args, context) {
  const { snapshot } = context
  const state = snapshot()
  const favoriteType = clean(args.favoriteType)
  const favorite = state.navigation.favorites?.[favoriteType]
  if (!favorite?.location) {
    return toolResult(`还没有设置${FAVORITE_LABELS[favoriteType] || '这个常用地点'}`, state, [], {
      navigation: state.navigation,
    })
  }
  return createRoutePlan({
    name: 'navigation_start',
    status: 'navigating',
    destination: favorite.name || FAVORITE_LABELS[favoriteType] || '常用地点',
    waypoints: [],
    strategy: normalizeStrategy(args.strategy, snapshot().navigation.strategy),
    context: {
      ...context,
      services: {
        ...context.services,
        async resolvePlace() { return favorite.location },
      },
    },
  })
}

async function setFavorite(args, context) {
  const { cockpitId, services, snapshot, store } = context
  const state = snapshot()
  const favoriteType = clean(args.favoriteType)
  if (!Object.hasOwn(FAVORITE_LABELS, favoriteType)) {
    return toolResult('请提供有效的常用地点类型', state, [], { navigation: state.navigation })
  }
  const address = clean(args.address)
  let location = null
  let name = address
  let displayAddress = address
  if (args.useCurrentLocation) {
    location = currentOrigin(state)
    name = '当前位置'
    displayAddress = '当前位置'
  } else if (address) {
    location = await resolvePlace(address, DEFAULT_ORIGIN.city, services)
  }
  if (!location) {
    return toolResult(`无法设置${FAVORITE_LABELS[favoriteType]}，请提供有效地址或使用当前位置`, state, [], {
      navigation: state.navigation,
    })
  }
  const nextState = store.update(cockpitId, ['navigation'], next => {
    next.navigation = {
      ...next.navigation,
      favorites: {
        ...next.navigation.favorites,
        [favoriteType]: {
          label: FAVORITE_LABELS[favoriteType],
          name,
          address: displayAddress,
          location,
        },
      },
    }
  })
  return toolResult(`已将${name}设置为${FAVORITE_LABELS[favoriteType]}`, nextState, ['navigation'], {
    navigation: nextState.navigation,
  })
}

function setVoice(args, context) {
  const { cockpitId, snapshot, store } = context
  const state = snapshot()
  const hasMute = typeof args.mute === 'boolean'
  const broadcastMode = clean(args.broadcastMode)
  if (!hasMute && !broadcastMode) {
    return toolResult('请告诉我要设置导航静音还是播报模式', state, [], { navigation: state.navigation })
  }
  if (broadcastMode && !VALID_VOICE_MODES.has(broadcastMode)) {
    return toolResult('请提供有效的导航播报模式', state, [], { navigation: state.navigation })
  }
  const nextState = store.update(cockpitId, ['navigation'], next => {
    next.navigation = {
      ...next.navigation,
      voice: {
        ...next.navigation.voice,
        muted: hasMute ? args.mute : next.navigation.voice?.muted || false,
        broadcastMode: broadcastMode || next.navigation.voice?.broadcastMode || 'standard',
      },
    }
  })
  const parts = []
  if (hasMute) parts.push(args.mute ? '已开启导航静音' : '已关闭导航静音')
  if (broadcastMode) {
    const modeText = broadcastMode === 'detailed' ? '详细播报' : broadcastMode === 'brief' ? '简洁播报' : '标准播报'
    parts.push(`已切换到${modeText}`)
  }
  return toolResult(parts.join('，'), nextState, ['navigation'], { navigation: nextState.navigation })
}

function setView(args, context) {
  const { cockpitId, snapshot, store } = context
  const state = snapshot()
  const viewMode = clean(args.viewMode)
  if (!viewMode) return toolResult('请告诉我要切换到哪种导航视图', state, [], { navigation: state.navigation })
  if (!VALID_VIEW_MODES.has(viewMode)) {
    return toolResult('请提供有效的导航视图模式', state, [], { navigation: state.navigation })
  }
  const nextState = store.update(cockpitId, ['navigation'], next => {
    next.navigation = {
      ...next.navigation,
      viewMode,
    }
  })
  const modeText = viewMode === 'overview' ? '路线全览' : viewMode === 'north_up' ? '北向上' : '跟车视角'
  return toolResult(`已切换到${modeText}`, nextState, ['navigation'], { navigation: nextState.navigation })
}

export async function executeNavigationTool(name, args, context) {
  const {
    cockpitId,
    onActivity,
    snapshot,
    store,
  } = context
  if (name === 'navigation_stop') {
    const state = store.update(cockpitId, ['navigation'], next => {
      next.navigation = {
        ...next.navigation,
        status: 'idle',
        destination: null,
        destinationLocation: null,
        waypoints: [],
        waypointLocations: [],
        route: null,
        map: { markers: [], polylines: [] },
      }
    })
    reportActivity(onActivity, 'navigation', 'navigation_stopped', '已停止导航')
    return toolResult('已停止导航', state, ['navigation'], { navigation: state.navigation })
  }

  if (name === 'navigation_add_waypoint') return addWaypoint(args, context)
  if (name === 'navigation_remove_waypoint') return removeWaypoint(args, context)
  if (name === 'navigation_change_destination') return changeDestination(args, context)
  if (name === 'navigation_set_route_strategy') return setRouteStrategy(args, context)
  if (name === 'navigation_search_place') return searchPlace(args, context)
  if (name === 'navigation_to_favorite') return navigateToFavorite(args, context)
  if (name === 'navigation_set_favorite') return setFavorite(args, context)
  if (name === 'navigation_set_voice') return setVoice(args, context)
  if (name === 'navigation_set_view') return setView(args, context)

  const destination = clean(args.destination)
  if (!destination && name === 'navigation_route_query') {
    const state = snapshot()
    const navigation = state.navigation
    if (!navigation.route || navigation.status === 'idle') {
      return toolResult('当前没有进行中的导航，请先告诉我要去哪里', state, [], {
        navigation,
      })
    }
    const waypointText = (navigation.waypoints || []).length
      ? `，途经${navigation.waypoints.join('、')}`
      : ''
    return toolResult(
      `当前正${routeStatusText(navigation.status)}到${navigation.destination}${waypointText}，`
        + `全程${navigation.route.distKm}公里，约${navigation.route.durationMin}分钟`,
      state,
      [],
      { navigation },
    )
  }
  if (!destination) throw new Error('Destination is required')
  const waypoints = (Array.isArray(args.waypoints) ? args.waypoints : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_WAYPOINTS)
  return createRoutePlan({
    name,
    status: name === 'navigation_start' ? 'navigating' : 'preview',
    destination,
    waypoints,
    strategy: normalizeStrategy(args.strategy, snapshot().navigation.strategy),
    context,
  })
}
