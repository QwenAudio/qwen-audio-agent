import { geocode, searchPlace, drivingRoute, setCallListener, clearCallListener } from '../amap-mcp.mjs'

const ORIGIN_NAME = '阿里巴巴云谷园区'
const ORIGIN_LOCATION = '120.037239,30.318522'
const DEFAULT_CITY = '杭州'

async function resolveLocation(name) {
  const place = await searchPlace(name, DEFAULT_CITY)
  if (place?.location) return place.location
  const geo = await geocode(name, DEFAULT_CITY)
  return geo || null
}

function routeArgs(action, params = {}) {
  return {
    action,
    ...(params.destination ? { destination: params.destination } : {}),
    ...(params.via ? { via: params.via } : {}),
    ...(params.strategy != null ? { strategy: params.strategy } : {}),
  }
}

async function executeNavigation(params, context) {
  const subCalls = []
  setCallListener(info => {
    subCalls.push(info)
    if (context?.onSubCall) context.onSubCall(info)
  })
  const emitMap = (event) => { if (context?.onMapEvent) context.onMapEvent(event) }
  const emitProgress = (event) => {
    if (context?.onProgress) {
      context.onProgress({ domain: 'navigation', ...event })
    }
  }
  const strategy = params.strategy ?? context?.strategy ?? 0
  const { action, destination, via } = params

  if (action === 'stop') {
    emitProgress({ stage: 'navigation_stopped', message: '已停止导航', speakPolicy: 'silent' })
    clearCallListener()
    emitMap({ action: 'clear' })
    return { result: '已停止导航', action: { type: 'navigation', action: 'stop' } }
  }

  if (action !== 'start' && action !== 'query') {
    clearCallListener()
    return { result: '未知导航操作' }
  }

  if (!destination) {
    clearCallListener()
    return { result: '请提供目的地' }
  }

  emitProgress({ stage: 'searching_destination', message: '正在查找目的地', speakPolicy: 'if_slow' })
  const destLocation = await resolveLocation(destination)
  if (!destLocation) {
    emitProgress({ stage: 'destination_not_found', message: `没有找到${destination}`, speakPolicy: 'always' })
    clearCallListener()
    return { result: `无法找到"${destination}"的位置信息，请换个说法重试`, subCalls }
  }
  emitProgress({ stage: 'destination_locked', message: `已锁定${destination}`, speakPolicy: 'silent' })
  emitMap({ action: 'add_marker', name: destination, location: destLocation, role: 'destination' })

  let viaLocation = null
  if (via) {
    emitProgress({ stage: 'searching_via', message: `正在查找途经点${via}`, speakPolicy: 'if_slow' })
    viaLocation = await resolveLocation(via)
    if (viaLocation) {
      emitProgress({ stage: 'via_locked', message: `已锁定途经点${via}`, speakPolicy: 'silent' })
      emitMap({ action: 'add_marker', name: via, location: viaLocation, role: 'via' })
    }
  }

  const originLoc = ORIGIN_LOCATION
  const destLoc = destLocation
  let resultText, routeData

  if (viaLocation) {
    emitProgress({ stage: 'planning_route', message: '正在规划路线', speakPolicy: 'always' })
    const leg1 = await drivingRoute(originLoc, viaLocation, strategy)
    if (leg1) {
      emitMap({ action: 'add_polyline', polyline: leg1.polyline, trafficSegments: leg1.trafficSegments, segment: 0 })
    }
    const leg2 = await drivingRoute(viaLocation, destLoc, strategy)
    if (leg2) {
      emitMap({ action: 'add_polyline', polyline: leg2.polyline, trafficSegments: leg2.trafficSegments, segment: 1 })
    }

    if (leg1 && leg2) {
      const totalDistance = leg1.distance + leg2.distance
      const totalDuration = leg1.duration + leg2.duration
      const polyline = [leg1.polyline, leg2.polyline].filter(Boolean).join(';')
      const trafficSegments = [leg1.trafficSegments, leg2.trafficSegments].flat().filter(Boolean)
      const distKm = (totalDistance / 1000).toFixed(1)
      const durationMin = Math.ceil(totalDuration / 60)
      const arrival = new Date(Date.now() + totalDuration * 1000)
      const arrivalStr = `${arrival.getHours().toString().padStart(2, '0')}:${arrival.getMinutes().toString().padStart(2, '0')}`
      routeData = { distance: totalDistance, duration: totalDuration, distKm, durationMin, arrivalStr, polyline, trafficSegments, destination, via, destLocation: destLoc, viaLocation }
      resultText = `已规划路线：${ORIGIN_NAME} → ${via} → ${destination}，全程${distKm}公里，约${durationMin}分钟`
    }
  }

  if (!routeData) {
    emitProgress({ stage: 'planning_route', message: '正在规划路线', speakPolicy: 'always' })
    const route = await drivingRoute(originLoc, destLoc, strategy)
    if (!route) {
      emitProgress({ stage: 'route_failed', message: '路线规划失败', speakPolicy: 'always' })
      clearCallListener()
      return { result: '路线规划失败，请稍后重试', subCalls }
    }
    emitMap({ action: 'add_polyline', polyline: route.polyline, trafficSegments: route.trafficSegments, segment: 0 })
    const distKm = (route.distance / 1000).toFixed(1)
    const durationMin = Math.ceil(route.duration / 60)
    const arrival = new Date(Date.now() + route.duration * 1000)
    const arrivalStr = `${arrival.getHours().toString().padStart(2, '0')}:${arrival.getMinutes().toString().padStart(2, '0')}`
    routeData = { ...route, distKm, durationMin, arrivalStr, destination, via, destLocation: destLoc }
    const viaText = via ? `（途经${via}）` : ''
    resultText = `已规划路线：${ORIGIN_NAME} → ${destination}${viaText}，全程${distKm}公里，约${durationMin}分钟`
  }

  clearCallListener()
  const out = { result: resultText, subCalls }
  if (action === 'start') {
    emitProgress({ stage: 'navigation_started', message: '开始导航', speakPolicy: 'silent' })
    out.action = { type: 'navigation', action: 'start', destination, via, route: routeData, strategy }
  } else {
    emitProgress({ stage: 'route_ready', message: '路线规划好了', speakPolicy: 'always' })
  }
  return out
}

export default {
  'navigation.start': (params, context) => executeNavigation(routeArgs('start', params), context),
  'navigation.route_query': (params, context) => executeNavigation(routeArgs('query', params), context),
  'navigation.stop': (_params, context) => executeNavigation({ action: 'stop' }, context),
}
