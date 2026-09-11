import { useRef, useEffect, useMemo, useCallback, useState } from 'react'
import AMapLoader from '@amap/amap-jsapi-loader'
import { navigationRouteKey, navigationRouteView } from '../projections/navigation-route'
import { routeFlowFrame } from '../projections/route-flow'

window._AMapSecurityConfig = {
  securityJsCode: import.meta.env.VITE_AMAP_SECRET,
}

const DEFAULT_CENTER = [120.037239, 30.318522]
const ACTION_INTERVAL = 500
const POLYLINE_ANIM_DURATION = 1600
const CAMERA_FOCUS_DURATION = 700
const CAMERA_EXPAND_DURATION = 1200
const CAMERA_DESTINATION_HOLD = 760
const CAMERA_MASK_LEAD = 220
const CAMERA_SETTLE_DURATION = 700
const CAMERA_ROUTE_OVERVIEW_DURATION = 900
const CAMERA_DEST_ZOOM = 15.4
const CAMERA_FOLLOW_ZOOM = 17.6
const TRAFFIC_STATUS_COLORS = {
  畅通: '#29d66f',
  缓行: '#ffd24a',
  拥堵: '#ff6b3d',
  严重拥堵: '#e8344e',
  未知: '#35d6c2',
}

const STRATEGIES = [
  { value: 0, label: '智能推荐' },
  { value: 13, label: '高速优先' },
  { value: 5, label: '不走高速' },
  { value: 4, label: '躲避拥堵' },
  { value: 11, label: '少收费' },
  { value: 14, label: '大路优先' },
  { value: 2, label: '时间优先' },
]

const DESTINATION_SHORTCUTS = [
  { type: 'home', label: '家', title: '回家' },
  { type: 'office', label: '公司', title: '去公司' },
]

export default function MapPanel({
  navState,
  navProgress,
  mapActions,
  routeStrategy,
  onStrategyChange,
  onFavoriteNavigate,
  onFavoriteSetup,
  onSearchDestination,
}) {
  const mapRef = useRef(null)
  const mapInstance = useRef(null)
  const amapRef = useRef(null)
  const vehicleMarkerRef = useRef(null)
  const routeLayersRef = useRef([])
  const routeFlowLayersRef = useRef([])
  const markersRef = useRef([])
  const previewPolylinesRef = useRef([])
  const previewMarkersRef = useRef([])
  const queueRef = useRef([])
  const processingRef = useRef(false)
  const processedCountRef = useRef(0)
  const timerRef = useRef(null)
  const routeRafRef = useRef(null)
  const flowRafRef = useRef(null)
  const cameraRafRef = useRef(null)
  const cameraTimersRef = useRef([])
  const currentViewModeRef = useRef(navState?.viewMode || 'follow')
  const lastAppliedViewModeRef = useRef(navState?.viewMode || 'follow')
  const [cameraStage, setCameraStage] = useState('idle')
  const [mapReady, setMapReady] = useState(false)

  const parsePolyline = useCallback((polyline, AMap) => polyline.split(';').map(p => {
    const [lng, lat] = p.split(',').map(Number)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
    return new AMap.LngLat(lng, lat)
  }).filter(Boolean), [])

  const parseTrafficSegments = useCallback((trafficSegments, AMap) => {
    if (!Array.isArray(trafficSegments)) return []
    return trafficSegments.map(segment => {
      const path = segment?.polyline ? parsePolyline(segment.polyline, AMap) : []
      if (path.length < 2) return null
      return {
        path,
        status: segment.status || '未知',
        color: TRAFFIC_STATUS_COLORS[segment.status] || TRAFFIC_STATUS_COLORS.未知,
      }
    }).filter(Boolean)
  }, [parsePolyline])

  const clearRouteLayers = useCallback((layers) => {
    const map = mapInstance.current
    if (!map) return
    layers.forEach(layer => map.remove(layer))
  }, [])

  const stopRouteFlow = useCallback(() => {
    if (flowRafRef.current) {
      cancelAnimationFrame(flowRafRef.current)
      flowRafRef.current = null
    }
    clearRouteLayers(routeFlowLayersRef.current)
    routeFlowLayersRef.current = []
  }, [clearRouteLayers])

  const clearCameraTimeline = useCallback(() => {
    cameraTimersRef.current.forEach(id => clearTimeout(id))
    cameraTimersRef.current = []
    if (cameraRafRef.current) {
      cancelAnimationFrame(cameraRafRef.current)
      cameraRafRef.current = null
    }
  }, [])

  const scheduleCameraStep = useCallback((fn, delay) => {
    const id = setTimeout(() => {
      cameraTimersRef.current = cameraTimersRef.current.filter(item => item !== id)
      fn()
    }, delay)
    cameraTimersRef.current.push(id)
  }, [])

  const createRouteLayers = useCallback((points, tone = 'primary', trafficSegments = []) => {
    const AMap = amapRef.current
    const map = mapInstance.current
    if (!AMap || !map || points.length === 0) return null

    const palette = tone === 'preview'
      ? { shadow: '#26323a', shadowOpacity: 0.14, main: '#65b6ff', glow: '#dff7ff' }
      : { shadow: '#26323a', shadowOpacity: 0.16, main: '#35d6c2', glow: '#e6fffb' }

    const shadow = new AMap.Polyline({
      path: points,
      strokeColor: palette.shadow,
      strokeWeight: 12,
      strokeOpacity: palette.shadowOpacity,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 8,
    })
    const parsedTrafficSegments = tone === 'primary' ? parseTrafficSegments(trafficSegments, AMap) : []
    const trafficLayers = parsedTrafficSegments.map(segment => ({
      segment,
      layer: new AMap.Polyline({
        path: [segment.path[0], segment.path[0]],
        strokeColor: segment.color,
        strokeWeight: 7,
        strokeOpacity: 0.96,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 10,
      }),
    }))
    const main = trafficLayers.length ? null : new AMap.Polyline({
      path: [points[0], points[0]],
      strokeColor: palette.main,
      strokeWeight: 7,
      strokeOpacity: 0.94,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 10,
    })
    const glow = new AMap.Polyline({
      path: [points[0], points[0]],
      strokeColor: palette.glow,
      strokeWeight: 3,
      strokeOpacity: trafficLayers.length ? 0.26 : 0.85,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 11,
    })

    const trafficLayerItems = trafficLayers.map(item => item.layer)
    const routeMainLayers = main ? [main] : trafficLayerItems
    const layers = [shadow, ...routeMainLayers, glow]
    const animated = trafficLayers.length
      ? [...trafficLayers.map(item => ({ layer: item.layer, path: item.segment.path })), glow]
      : [main, glow]

    map.add(layers)
    return { layers, animated }
  }, [parseTrafficSegments])

  const startRouteFlow = useCallback((points) => {
    const AMap = amapRef.current
    const map = mapInstance.current
    if (!AMap || !map || points.length < 8) return
    stopRouteFlow()

    const traveledEnd = Math.max(2, Math.floor(points.length * 0.08))
    const aheadEnd = Math.max(traveledEnd + 2, Math.floor(points.length * 0.26))
    const traveled = new AMap.Polyline({
      path: points.slice(0, traveledEnd),
      strokeColor: '#7eafc2',
      strokeWeight: 7,
      strokeOpacity: 0.28,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 12,
    })
    const ahead = new AMap.Polyline({
      path: points.slice(traveledEnd, aheadEnd),
      strokeColor: '#78fff1',
      strokeWeight: 5,
      strokeOpacity: 0.72,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 13,
    })
    const flow = new AMap.Polyline({
      path: points.slice(traveledEnd, aheadEnd),
      strokeColor: '#ffffff',
      strokeWeight: 3,
      strokeOpacity: 0.86,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 14,
    })
    map.add([traveled, ahead, flow])
    routeFlowLayersRef.current = [traveled, ahead, flow]

    const startTime = performance.now()
    const tick = (now) => {
      const frame = routeFlowFrame(points, now - startTime)
      flow.setPath(frame.path)
      if (frame.done) {
        stopRouteFlow()
        return
      }
      flowRafRef.current = requestAnimationFrame(tick)
    }

    flowRafRef.current = requestAnimationFrame(tick)
  }, [stopRouteFlow])

  const animateRoute = useCallback((animatedLayers, points, onComplete) => {
    if (routeRafRef.current) cancelAnimationFrame(routeRafRef.current)
    const start = performance.now()
    const duration = POLYLINE_ANIM_DURATION
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3)

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = easeOutCubic(progress)
      const endIdx = Math.max(2, Math.ceil(points.length * eased))
      const path = points.slice(0, endIdx)
      const trafficItems = animatedLayers.filter(item => item?.path && item?.layer)
      const trafficUnits = trafficItems.reduce((sum, item) => sum + Math.max(1, item.path.length - 1), 0)
      let trafficOffset = 0
      animatedLayers.forEach(item => {
        if (item?.path && item?.layer) {
          const units = Math.max(1, item.path.length - 1)
          const visibleUnits = trafficUnits * eased - trafficOffset
          if (visibleUnits <= 0) {
            item.layer.setPath([item.path[0], item.path[0]])
          } else if (visibleUnits >= units) {
            item.layer.setPath(item.path)
          } else {
            item.layer.setPath(item.path.slice(0, Math.max(2, Math.ceil(visibleUnits) + 1)))
          }
          trafficOffset += units
        } else {
          item.setPath(path)
        }
      })

      if (progress < 1) {
        routeRafRef.current = requestAnimationFrame(tick)
      } else {
        animatedLayers.forEach(item => {
          if (item?.path && item?.layer) {
            item.layer.setPath(item.path)
          } else {
            item.setPath(points)
          }
        })
        routeRafRef.current = null
        onComplete?.()
      }
    }

    routeRafRef.current = requestAnimationFrame(tick)
  }, [])

  const getLngLat = useCallback((point) => ({
    lng: typeof point.getLng === 'function' ? point.getLng() : point.lng,
    lat: typeof point.getLat === 'function' ? point.getLat() : point.lat,
  }), [])

  const getMapPitch = useCallback((map) => typeof map.getPitch === 'function' ? map.getPitch() : 0, [])
  const getMapRotation = useCallback((map) => typeof map.getRotation === 'function' ? map.getRotation() : 0, [])

  const setMapCamera = useCallback((map, center, zoom, pitch, rotation) => {
    map.setZoomAndCenter(zoom, center)
    if (typeof map.setPitch === 'function') map.setPitch(pitch)
    if (typeof map.setRotation === 'function') map.setRotation(rotation)
  }, [])

  const tweenCamera = useCallback((target, duration, onComplete) => {
    const map = mapInstance.current
    const AMap = amapRef.current
    if (!map || !AMap) return
    if (cameraRafRef.current) cancelAnimationFrame(cameraRafRef.current)

    const startCenter = getLngLat(map.getCenter())
    const targetCenter = Array.isArray(target.center)
      ? { lng: target.center[0], lat: target.center[1] }
      : getLngLat(target.center)
    const startZoom = map.getZoom()
    const targetZoom = target.zoom ?? startZoom
    const startPitch = getMapPitch(map)
    const targetPitch = target.pitch ?? startPitch
    const startRotation = getMapRotation(map)
    const targetRotation = target.rotation ?? startRotation
    const start = performance.now()
    const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = easeInOutCubic(progress)
      const lng = startCenter.lng + (targetCenter.lng - startCenter.lng) * eased
      const lat = startCenter.lat + (targetCenter.lat - startCenter.lat) * eased
      const zoom = startZoom + (targetZoom - startZoom) * eased
      const pitch = startPitch + (targetPitch - startPitch) * eased
      const rotation = startRotation + (targetRotation - startRotation) * eased
      setMapCamera(map, new AMap.LngLat(lng, lat), zoom, pitch, rotation)

      if (progress < 1) {
        cameraRafRef.current = requestAnimationFrame(tick)
      } else {
        cameraRafRef.current = null
        onComplete?.()
      }
    }

    cameraRafRef.current = requestAnimationFrame(tick)
  }, [getLngLat, getMapPitch, getMapRotation, setMapCamera])

  const calculateBearing = useCallback((fromPoint, toPoint) => {
    const from = getLngLat(fromPoint)
    const to = getLngLat(toPoint)
    const toRad = deg => deg * Math.PI / 180
    const toDeg = rad => rad * 180 / Math.PI
    const lat1 = toRad(from.lat)
    const lat2 = toRad(to.lat)
    const deltaLng = toRad(to.lng - from.lng)
    const y = Math.sin(deltaLng) * Math.cos(lat2)
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
  }, [getLngLat])

  const getRouteCamera = useCallback((points) => {
    const coords = points.map(getLngLat)
    const lngs = coords.map(p => p.lng)
    const lats = coords.map(p => p.lat)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const span = Math.max(maxLng - minLng, maxLat - minLat, 0.003)
    const zoom = Math.max(11.2, Math.min(15.8, 13.8 - Math.log2(span / 0.08)))
    const targetIndex = Math.min(points.length - 1, Math.max(1, Math.floor(points.length * 0.08)))

    return {
      center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
      zoom,
      pitch: 46,
      rotation: calculateBearing(points[0], points[targetIndex]),
    }
  }, [calculateBearing, getLngLat])

  const getFullRouteCamera = useCallback((points) => {
    const coords = points.map(getLngLat)
    const lngs = coords.map(p => p.lng)
    const lats = coords.map(p => p.lat)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const span = Math.max((maxLng - minLng) * 1.65, (maxLat - minLat) * 1.85, 0.006)
    const zoom = Math.max(10.5, Math.min(14.8, 13.8 - Math.log2(span / 0.08)))

    return {
      center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
      zoom,
      pitch: 28,
      rotation: 0,
    }
  }, [getLngLat])

  const getFollowCamera = useCallback((points) => {
    const start = getLngLat(points[0])
    const aheadIndex = Math.min(points.length - 1, Math.max(1, Math.floor(points.length * 0.18)))
    const bearing = calculateBearing(points[0], points[aheadIndex])
    return {
      center: [start.lng, start.lat],
      zoom: CAMERA_FOLLOW_ZOOM,
      pitch: 62,
      rotation: bearing,
    }
  }, [calculateBearing, getLngLat])

  const rotateVehiclePuck = useCallback((bearing) => {
    const marker = vehicleMarkerRef.current
    const el = marker?.getContent?.()
    if (typeof el === 'string') return
    const puck = el?.querySelector?.('.vehicle-puck')
    if (puck) puck.style.transform = `rotate(${bearing}deg)`
  }, [])

  const routeKey = navigationRouteKey(navState)
  const routeInfo = useMemo(() => navigationRouteView(JSON.parse(routeKey)), [routeKey])
  const navigationViewMode = navState?.viewMode || 'follow'
  const navigationVoiceLabel = useMemo(() => {
    if (navState?.voice?.muted) return '导航静音'
    if (navState?.voice?.broadcastMode === 'detailed') return '详细播报'
    if (navState?.voice?.broadcastMode === 'brief') return '简洁播报'
    return '标准播报'
  }, [navState?.voice?.broadcastMode, navState?.voice?.muted])
  const destinationShortcuts = useMemo(() => DESTINATION_SHORTCUTS.map(item => {
    const favorite = navState?.favorites?.[item.type]
    const subtitle = favorite?.address || favorite?.name || '点击设置'
    return {
      ...item,
      subtitle,
      configured: Boolean(favorite?.location),
    }
  }), [navState?.favorites])

  const activeNavProgress = useMemo(() => (
    navProgress?.domain === 'navigation' && navProgress.message ? navProgress : null
  ), [navProgress])

  const routeStageLabel = useMemo(() => {
    if (cameraStage === 'focus' || cameraStage === 'expand') return '查找目的地'
    if (cameraStage === 'destination') return '目的地已锁定'
    if (cameraStage === 'draw') return '路线生成中'
    if (cameraStage === 'settle') return '准备进入导航'
    if (cameraStage === 'tracking') return '导航中'
    return '路线规划'
  }, [cameraStage])

  const progressStageLabel = useMemo(() => {
    if (activeNavProgress?.stage === 'searching_destination' || activeNavProgress?.stage === 'searching_waypoint') return '查找目的地'
    if (activeNavProgress?.stage === 'destination_locked' || activeNavProgress?.stage === 'waypoint_locked') return '目的地已锁定'
    if (activeNavProgress?.stage === 'planning_route') return '路线生成中'
    if (activeNavProgress?.stage === 'route_ready' || activeNavProgress?.stage === 'navigation_started') return '准备进入导航'
    return '路线规划'
  }, [activeNavProgress])

  const showRouteMetrics = cameraStage === 'settle' || cameraStage === 'tracking'

  const escapeHtml = useCallback((text = '') => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'), [])

  const getDestinationMarkerContent = useCallback((name) => (
    `<div class="destination-pin"><div class="dest-marker target-lock marker-pop"></div><span>${escapeHtml(name)}</span></div>`
  ), [escapeHtml])

  const applyRouteViewMode = useCallback((viewMode) => {
    const AMap = amapRef.current
    if (!AMap || !routeInfo?.polyline) return

    const points = parsePolyline(routeInfo.polyline, AMap)
    if (points.length < 2) return

    clearCameraTimeline()
    if (viewMode === 'overview') {
      setCameraStage('settle')
      tweenCamera(getFullRouteCamera(points), CAMERA_ROUTE_OVERVIEW_DURATION)
      return
    }

    const followCamera = getFollowCamera(points)
    rotateVehiclePuck(followCamera.rotation)
    setCameraStage(routeInfo.status === 'navigating' ? 'tracking' : 'settle')
    tweenCamera({
      ...followCamera,
      rotation: viewMode === 'north_up' ? 0 : followCamera.rotation,
    }, CAMERA_SETTLE_DURATION)
  }, [clearCameraTimeline, getFollowCamera, getFullRouteCamera, parsePolyline, routeInfo, rotateVehiclePuck, tweenCamera])

  const clearPreview = useCallback(() => {
    const map = mapInstance.current
    if (!map) return
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (routeRafRef.current) {
      cancelAnimationFrame(routeRafRef.current)
      routeRafRef.current = null
    }
    stopRouteFlow()
    previewPolylinesRef.current.forEach(p => map.remove(p))
    previewPolylinesRef.current = []
    previewMarkersRef.current.forEach(m => map.remove(m))
    previewMarkersRef.current = []
    queueRef.current = []
    processingRef.current = false
    processedCountRef.current = 0
  }, [stopRouteFlow])

  const processNextRef = useRef(null)

  useEffect(() => {
    processNextRef.current = () => {
      if (processingRef.current) return
      const next = queueRef.current.shift()
      if (!next) return

      processingRef.current = true
      const AMap = amapRef.current
      const map = mapInstance.current
      if (!AMap || !map) { processingRef.current = false; return }

      const scheduleNext = () => {
        timerRef.current = setTimeout(() => {
          processingRef.current = false
          processNextRef.current?.()
        }, ACTION_INTERVAL)
      }

      if (next.action === 'add_marker') {
        const [lng, lat] = next.location.split(',').map(Number)
        const cls = next.role === 'waypoint' ? 'waypoint-marker' : 'dest-marker'
        const offset = next.role === 'waypoint' ? new AMap.Pixel(-8, -8) : new AMap.Pixel(-10, -10)
        const marker = new AMap.Marker({
          position: new AMap.LngLat(lng, lat),
          map,
          content: `<div class="${cls} marker-pop"></div>`,
          offset,
        })
        previewMarkersRef.current.push(marker)
        scheduleNext()
      } else if (next.action === 'add_polyline') {
        const allPoints = parsePolyline(next.polyline, AMap)
        if (allPoints.length === 0) {
          processingRef.current = false
          processNextRef.current?.()
          return
        }

        const routeLayers = createRouteLayers(allPoints, 'preview', next.trafficSegments)
        if (!routeLayers) {
          processingRef.current = false
          processNextRef.current?.()
          return
        }
        previewPolylinesRef.current.push(...routeLayers.layers)
        animateRoute(routeLayers.animated, allPoints, () => {
          scheduleNext()
        })
      } else {
        processingRef.current = false
        processNextRef.current?.()
      }
    }
  })

  useEffect(() => {
    let cancelled = false
    AMapLoader.load({
      key: import.meta.env.VITE_AMAP_KEY,
      version: '2.0',
    }).then(AMap => {
      if (cancelled) return
      amapRef.current = AMap
      mapInstance.current = new AMap.Map(mapRef.current, {
        zoom: 16,
        center: DEFAULT_CENTER,
        mapStyle: 'amap://styles/whitesmoke',
        viewMode: '3D',
        features: ['bg', 'road', 'building', 'point'],
        showBuildingBlock: true,
        rotateEnable: true,
        pitchEnable: true,
        pitch: 42,
        rotation: 0,
      })

      vehicleMarkerRef.current = new AMap.Marker({
        position: DEFAULT_CENTER,
        map: mapInstance.current,
        content: (() => {
          const el = document.createElement('div')
          el.innerHTML = '<div class="vehicle-puck"><span></span></div>'
          return el.firstChild
        })(),
        offset: new AMap.Pixel(-14, -18),
        zIndex: 100,
      })
      setMapReady(true)
    })

    return () => {
      cancelled = true
      setMapReady(false)
      if (timerRef.current) clearTimeout(timerRef.current)
      if (routeRafRef.current) cancelAnimationFrame(routeRafRef.current)
      stopRouteFlow()
      clearCameraTimeline()
      mapInstance.current?.destroy()
    }
  }, [clearCameraTimeline, stopRouteFlow])

  useEffect(() => {
    const AMap = amapRef.current
    const map = mapInstance.current
    if (!mapReady || !AMap || !map) return

    clearCameraTimeline()
    stopRouteFlow()
    clearRouteLayers(routeLayersRef.current)
    routeLayersRef.current = []
    markersRef.current.forEach(m => map.remove(m))
    markersRef.current = []
    clearPreview()

    if (routeInfo) {
      const route = routeInfo

      if (route.polyline) {
        const points = parsePolyline(route.polyline, AMap)

        if (points.length > 0) {
          scheduleCameraStep(() => {
            setCameraStage('focus')
            tweenCamera({ center: DEFAULT_CENTER, zoom: 16, pitch: 48, rotation: 0 }, CAMERA_FOCUS_DURATION)
          }, 0)

          scheduleCameraStep(() => {
            setCameraStage('expand')
          }, CAMERA_FOCUS_DURATION)

          scheduleCameraStep(() => {
            const endMarker = new AMap.Marker({
              position: points[points.length - 1],
              map,
              content: getDestinationMarkerContent(route.destination),
              offset: new AMap.Pixel(-18, -36),
            })
            markersRef.current.push(endMarker)

            for (const location of route.waypointLocations || []) {
              const [vLng, vLat] = location.split(',').map(Number)
              const waypointMarker = new AMap.Marker({
                position: new AMap.LngLat(vLng, vLat),
                map,
                content: '<div class="waypoint-marker marker-pop"></div>',
                offset: new AMap.Pixel(-8, -8),
              })
              markersRef.current.push(waypointMarker)
            }

            tweenCamera({
              center: points[points.length - 1],
              zoom: CAMERA_DEST_ZOOM,
              pitch: 50,
              rotation: calculateBearing(points[0], points[Math.min(points.length - 1, Math.max(1, Math.floor(points.length * 0.08)))]),
            }, CAMERA_EXPAND_DURATION)
            scheduleCameraStep(() => {
              setCameraStage('destination')
            }, CAMERA_EXPAND_DURATION)

            scheduleCameraStep(() => {
              setCameraStage('draw')
              const routeLayers = createRouteLayers(points, 'primary', route.trafficSegments)
              routeLayersRef.current = routeLayers?.layers || []

              if (routeLayers) {
                tweenCamera(getRouteCamera(points), CAMERA_ROUTE_OVERVIEW_DURATION)
                animateRoute(routeLayers.animated, points, () => {
                  startRouteFlow(points)
                  setCameraStage('settle')
                  const viewMode = currentViewModeRef.current
                  if (viewMode === 'overview') {
                    tweenCamera(getFullRouteCamera(points), CAMERA_SETTLE_DURATION)
                    return
                  }
                  if (route.status !== 'navigating') return
                  const followCamera = getFollowCamera(points)
                  rotateVehiclePuck(followCamera.rotation)
                  tweenCamera({
                    ...followCamera,
                    rotation: viewMode === 'north_up' ? 0 : followCamera.rotation,
                  }, CAMERA_SETTLE_DURATION, () => setCameraStage('tracking'))
                })
              }
            }, CAMERA_EXPAND_DURATION + CAMERA_DESTINATION_HOLD)
          }, CAMERA_FOCUS_DURATION + CAMERA_MASK_LEAD)
        }
      } else if (route.destLocation) {
        const [lng, lat] = route.destLocation.split(',').map(Number)
        const destPos = new AMap.LngLat(lng, lat)

        scheduleCameraStep(() => {
          setCameraStage('focus')
          tweenCamera({ center: DEFAULT_CENTER, zoom: 16, pitch: 48, rotation: 0 }, CAMERA_FOCUS_DURATION)
        }, 0)
        scheduleCameraStep(() => {
          setCameraStage('expand')
        }, CAMERA_FOCUS_DURATION)
        scheduleCameraStep(() => {
          const endMarker = new AMap.Marker({
            position: destPos,
            map,
            content: getDestinationMarkerContent(route.destination),
            offset: new AMap.Pixel(-18, -36),
          })
          markersRef.current.push(endMarker)
          tweenCamera({ center: destPos, zoom: CAMERA_DEST_ZOOM, pitch: 50, rotation: 0 }, CAMERA_EXPAND_DURATION)
          scheduleCameraStep(() => {
            setCameraStage('destination')
          }, CAMERA_EXPAND_DURATION)
          scheduleCameraStep(() => {
            setCameraStage('settle')
            if (route.status === 'navigating') {
              tweenCamera({ center: destPos, zoom: 16.4, pitch: 54, rotation: 0 }, CAMERA_SETTLE_DURATION, () => setCameraStage('tracking'))
            }
          }, CAMERA_EXPAND_DURATION + CAMERA_DESTINATION_HOLD)
        }, CAMERA_FOCUS_DURATION + CAMERA_MASK_LEAD)
      }
    } else if (navState?.status === 'idle') {
      scheduleCameraStep(() => setCameraStage('idle'), 0)
      tweenCamera({ center: DEFAULT_CENTER, zoom: 14, pitch: 42, rotation: 0 }, 520)
    }
  }, [navState?.status, routeInfo, mapReady, clearPreview, clearRouteLayers, createRouteLayers, animateRoute, parsePolyline, clearCameraTimeline, stopRouteFlow, scheduleCameraStep, tweenCamera, calculateBearing, getRouteCamera, getFollowCamera, getFullRouteCamera, getDestinationMarkerContent, startRouteFlow, rotateVehiclePuck])

  useEffect(() => {
    currentViewModeRef.current = navigationViewMode
    if (lastAppliedViewModeRef.current === navigationViewMode) return
    lastAppliedViewModeRef.current = navigationViewMode
    applyRouteViewMode(navigationViewMode)
  }, [applyRouteViewMode, navigationViewMode])

  useEffect(() => {
    if (!mapReady || routeInfo || !activeNavProgress) return undefined

    const frame = requestAnimationFrame(() => {
      if (activeNavProgress.stage === 'searching_destination' || activeNavProgress.stage === 'searching_waypoint') {
        clearCameraTimeline()
        setCameraStage('focus')
        tweenCamera({ center: DEFAULT_CENTER, zoom: 16.2, pitch: 48, rotation: -8 }, 520)
      } else if (activeNavProgress.stage === 'destination_locked' || activeNavProgress.stage === 'waypoint_locked') {
        setCameraStage('destination')
      } else if (activeNavProgress.stage === 'planning_route') {
        setCameraStage('draw')
      } else if (activeNavProgress.stage === 'route_ready' || activeNavProgress.stage === 'navigation_started') {
        setCameraStage('settle')
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [activeNavProgress, clearCameraTimeline, mapReady, routeInfo, tweenCamera])

  useEffect(() => {
    if (!mapReady) return
    if (!mapActions || mapActions.length === 0) {
      clearPreview()
      return
    }

    const newActions = mapActions.slice(processedCountRef.current)
    if (newActions.length === 0) return

    processedCountRef.current = mapActions.length
    queueRef.current.push(...newActions)

    if (!processingRef.current) {
      processNextRef.current()
    }
  }, [mapActions, mapReady, clearPreview])

  function handleLocate() {
    mapInstance.current?.setZoomAndCenter(16, DEFAULT_CENTER)
  }

  return (
    <section className={`map-panel${routeInfo || activeNavProgress ? ' is-routing' : ''} camera-${cameraStage}`} aria-label="导航区域">
      <div ref={mapRef} className="map-field" />
      {(routeInfo || activeNavProgress) && (
        <div className="camera-transition" aria-hidden="true"></div>
      )}
      {routeInfo && (
        <div className="nav-ai-strip">
          <span className="nav-ai-dot"></span>
          <span>AI 已为你规划路线</span>
          <strong>{routeInfo.durationMin} 分钟</strong>
          <span className="nav-voice-badge">{navigationVoiceLabel}</span>
        </div>
      )}
      {routeInfo && (
        <div className={`route-card is-committed route-stage-${cameraStage}`}>
          <div className="route-head">
            <svg className="turn-icon" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="currentColor" d="M13 40V18c0-5 4-9 9-9h6V3l11 10-11 10v-7h-6c-1.2 0-2 .8-2 2v22h-7Z" />
            </svg>
            <div>
              <div className="route-stage-label">{routeStageLabel}</div>
              {showRouteMetrics ? (
                <div className="route-meter"><strong>{routeInfo.distKm}</strong><span>公里</span></div>
              ) : (
                <div className="route-destination-title">{routeInfo.destination}</div>
              )}
              {showRouteMetrics && <div className="route-road">{routeInfo.destination}</div>}
            </div>
          </div>
          <div className="route-progress"><span></span></div>
          {showRouteMetrics && (
            <div className="route-meta">
              <span>{routeInfo.distKm} 公里</span>
              <span>{routeInfo.durationMin} 分钟</span>
              <span>{routeInfo.arrivalStr} 到达</span>
            </div>
          )}
        </div>
      )}
      {!routeInfo && activeNavProgress && (
        <div className={`route-card route-preview-card is-committed route-stage-${cameraStage}`}>
          <div className="route-head">
            <svg className="turn-icon" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="currentColor" d="M24 5 38 19h-9v8c0 7-5 13-12 13H9v-7h8c3 0 5-2 5-5v-9h-9L24 5Z" />
            </svg>
            <div>
              <div className="route-stage-label">{progressStageLabel}</div>
              <div className="route-destination-title">{activeNavProgress.message}</div>
            </div>
          </div>
          <div className="route-progress"><span></span></div>
        </div>
      )}
      {!routeInfo && !activeNavProgress && (
        <div className="destination-search-panel" aria-label="目的地搜索">
          <button className="destination-search-field" onClick={onSearchDestination} aria-label="搜索目的地">
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.8 4a6.8 6.8 0 0 1 5.43 10.9l3.44 3.43-1.42 1.42-3.43-3.44A6.8 6.8 0 1 1 10.8 4Zm0 2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Z" fill="currentColor" />
            </svg>
            <span>搜索目的地</span>
          </button>
          <div className="destination-shortcuts">
            {destinationShortcuts.map(item => (
              <div className={`destination-shortcut${item.configured ? ' is-configured' : ''}`} key={item.type}>
                <div className="destination-shortcut-icon" aria-hidden="true">{item.label.slice(0, 1)}</div>
                <div className="destination-shortcut-text">
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                </div>
                <button
                  className="destination-shortcut-action"
                  onClick={() => (
                    item.configured
                      ? onFavoriteNavigate?.(item.type)
                      : onFavoriteSetup?.(item.type)
                  )}
                >
                  {item.configured ? '导航' : '设置'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="map-bottom-bar">
        <div className="map-bottom-left">
          <button className="map-fab" aria-label="定位" onClick={handleLocate}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-1-8v2.07A8.001 8.001 0 0 0 4.07 11H2v2h2.07A8.001 8.001 0 0 0 11 19.93V22h2v-2.07A8.001 8.001 0 0 0 19.93 13H22v-2h-2.07A8.001 8.001 0 0 0 13 4.07V2h-2Zm1 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z" fill="currentColor" /></svg></button>
          <button className="map-fab" aria-label="路线"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm10 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm10 8a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-.7-8.7 1.4 1.4-9 9-1.4-1.4 9-9Z" fill="currentColor" /></svg></button>
          {routeInfo?.polyline && (
            <button className="map-overview-btn" aria-label="查看全程" onClick={() => applyRouteViewMode('overview')}>
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h5v2H7.41l3.3 3.29-1.42 1.42L6 7.41V10H4V5a1 1 0 0 1 1-1Zm9 0h5a1 1 0 0 1 1 1v5h-2V7.41l-3.29 3.3-1.42-1.42 3.3-3.29H14V4ZM6 16.59l3.29-3.3 1.42 1.42-3.3 3.29H10v2H5a1 1 0 0 1-1-1v-5h2v2.59Zm12 0V14h2v5a1 1 0 0 1-1 1h-5v-2h2.59l-3.3-3.29 1.42-1.42 3.29 3.3Z" fill="currentColor" /></svg>
              <span>查看全程</span>
            </button>
          )}
        </div>
        <div className="strategy-bar">
          {STRATEGIES.map(s => (
            <button
              key={s.value}
              className={`strategy-chip${routeStrategy === s.value ? ' active' : ''}`}
              onClick={() => onStrategyChange(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
