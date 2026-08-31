import { DEFAULT_ORIGIN } from './catalog.mjs'
import { clean, reportActivity, toolResult } from '../shared.mjs'

async function planRoute(destination, waypoints, strategy, { now, services }) {
  const stops = [DEFAULT_ORIGIN.location, ...waypoints, destination]
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

export async function executeNavigationTool(name, args, context) {
  const {
    cockpitId,
    onActivity,
    services,
    snapshot,
    store,
  } = context
  if (name === 'navigation_stop') {
    const state = store.update(cockpitId, ['navigation'], next => {
      next.navigation = {
        status: 'idle',
        destination: null,
        waypoints: [],
        strategy: next.navigation.strategy,
        route: null,
        map: { markers: [], polylines: [] },
      }
    })
    reportActivity(onActivity, 'navigation', 'navigation_stopped', '已停止导航')
    return toolResult('已停止导航', state, ['navigation'], { navigation: state.navigation })
  }

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
      `当前正${navigation.status === 'navigating' ? '导航' : '规划'}到${navigation.destination}${waypointText}，`
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
    .slice(0, 8)
  const strategy = Number(args.strategy) || 0
  reportActivity(onActivity, 'navigation', 'searching_destination', '正在查找目的地')
  const destinationLocation = await services.resolvePlace(destination, DEFAULT_ORIGIN.city)
  if (!destinationLocation) {
    reportActivity(onActivity, 'navigation', 'destination_not_found', `没有找到${destination}`)
    const state = snapshot()
    return toolResult(`无法找到“${destination}”的位置信息`, state, [])
  }
  reportActivity(onActivity, 'navigation', 'destination_locked', `已找到${destination}`)
  const waypointLocations = []
  for (const waypoint of waypoints) {
    reportActivity(onActivity, 'navigation', 'searching_waypoint', `正在查找途经点${waypoint}`)
    const location = await services.resolvePlace(waypoint, DEFAULT_ORIGIN.city)
    if (!location) {
      reportActivity(onActivity, 'navigation', 'waypoint_not_found', `没有找到${waypoint}`)
      return toolResult(`无法找到途经点“${waypoint}”的位置信息`, snapshot(), [])
    }
    waypointLocations.push(location)
    reportActivity(onActivity, 'navigation', 'waypoint_locked', `已找到途经点${waypoint}`)
  }
  reportActivity(onActivity, 'navigation', 'planning_route', '正在规划路线')
  const route = await planRoute(destinationLocation, waypointLocations, strategy, context)
  if (!route) {
    reportActivity(onActivity, 'navigation', 'route_failed', '路线规划失败')
    return toolResult('路线规划失败，请稍后重试', snapshot(), [])
  }
  const state = store.update(cockpitId, ['navigation'], next => {
    next.navigation = {
      status: name === 'navigation_start' ? 'navigating' : 'preview',
      destination,
      waypoints,
      strategy,
      route,
      map: {
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
      },
    }
  })
  const status = name === 'navigation_start' ? 'navigation_started' : 'route_ready'
  reportActivity(onActivity, 'navigation', status, name === 'navigation_start' ? '开始导航' : '路线规划好了')
  const waypointText = waypoints.length ? `，途经${waypoints.join('、')}` : ''
  const content = name === 'navigation_start'
    ? `已开始导航到${destination}${waypointText}，全程${route.distKm}公里，约${route.durationMin}分钟`
    : `已规划到${destination}${waypointText}的路线，全程${route.distKm}公里，约${route.durationMin}分钟`
  return toolResult(content, state, ['navigation'], { navigation: state.navigation })
}
