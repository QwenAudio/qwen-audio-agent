let callListener = null

const REQUEST_TIMEOUT_MS = 8_000
const REQUEST_ATTEMPTS = 2
const DRIVING_REQUEST_INTERVAL_MS = 600
let drivingRequestQueue = Promise.resolve()
let lastDrivingRequestAt = -Infinity

// A multi-stop route makes several driving queries. Share their start-time
// spacing across this service process, including overlapping routes and retries.
function waitForDrivingRequest() {
  const slot = drivingRequestQueue.then(async () => {
    const waitMs = DRIVING_REQUEST_INTERVAL_MS - (Date.now() - lastDrivingRequestAt)
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    lastDrivingRequestAt = Date.now()
  })
  drivingRequestQueue = slot.catch(() => {})
  return slot
}

export function setCallListener(listener) {
  callListener = listener
}

export function clearCallListener() {
  callListener = null
}

function emitCall(info) {
  callListener?.(info)
}

function key() {
  return String(process.env.AMAP_MCP_KEY || '').trim()
}

function extractText(result) {
  if (!result?.content) return null
  return result.content.find(item => item.type === 'text')?.text || null
}

function retryableStatus(status) {
  return status === 429 || status >= 500
}

async function fetchWithRetry(url, init = {}, {
  attempts = REQUEST_ATTEMPTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  beforeAttempt,
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await beforeAttempt?.()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (attempt < attempts && retryableStatus(response.status)) {
        await response.body?.cancel()
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt === attempts) throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

function assertSuccessfulResponse(response, service) {
  if (response.ok) return
  throw new Error(`${service}请求失败（HTTP ${response.status}）`)
}

async function callMcp(toolName, args) {
  const startedAt = Date.now()
  const response = await fetchWithRetry(`https://mcp.amap.com/mcp?key=${key()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: startedAt,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })
  assertSuccessfulResponse(response, '地图服务')
  const contentType = response.headers.get('content-type') || ''
  let result = null
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const data = JSON.parse(line.slice(5).trim())
        if (data.error) break
        if (data.result) {
          result = data.result
          break
        }
      } catch {}
    }
  } else {
    const data = await response.json()
    if (!data.error && !data.result?.isError) result = data.result || null
  }
  // Streamed tool errors follow the same contract as JSON responses.
  if (result?.isError) result = null
  emitCall({
    name: toolName,
    arguments: args,
    duration_ms: Date.now() - startedAt,
    result: extractText(result)?.slice(0, 100) || '',
  })
  return result
}

export async function geocode(address, city) {
  const args = { address }
  if (city) args.city = city
  const text = extractText(await callMcp('maps_geo', args))
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const geo = parsed.results?.[0] || parsed.geocodes?.[0]
    if (geo?.location) return geo.location
  } catch {}
  const match = text.match(/([\d.]+),([\d.]+)/u)
  return match ? `${match[1]},${match[2]}` : null
}

export async function searchPlace(keywords, city) {
  const places = await searchPlaces(keywords, { city, limit: 1 })
  return places[0] || null
}

function normalizePoi(poi) {
  if (!poi || typeof poi.name !== 'string' || !poi.name.trim()) return null
  const distance = typeof poi.distance === 'number'
    || (typeof poi.distance === 'string' && poi.distance.trim())
    ? Number(poi.distance)
    : NaN
  return {
    id: typeof poi.id === 'string' ? poi.id : '',
    name: poi.name.trim(),
    type: poi.type || poi.typecode || '',
    address: Array.isArray(poi.address) ? poi.address.join('') : poi.address || '',
    distance: Number.isFinite(distance) && distance >= 0 ? distance : null,
    location: typeof poi.location === 'string' ? poi.location : '',
  }
}

async function searchPoiResults(toolName, args, { limit, fillLocation = false }) {
  try {
    const text = extractText(await callMcp(toolName, args))
    const parsed = text ? JSON.parse(text) : null
    if (!parsed || !Array.isArray(parsed.pois)
      || parsed.error || parsed.isError
      || (parsed.status !== undefined && String(parsed.status) !== '1')) {
      throw new Error('Invalid POI response')
    }
    const places = parsed.pois.map(normalizePoi).filter(Boolean)
    if (parsed.pois.length && !places.length) throw new Error('Invalid POI entries')
    const selected = places.slice(0, limit)
    if (fillLocation) {
      for (const place of selected) {
        if (!place.location && place.id) place.location = await getPoiLocation(place.id) || ''
      }
    }
    return selected
  } catch {
    // Never expose upstream payloads, request URLs, or credentials to callers.
    throw new Error('地点搜索服务返回异常，请稍后重试')
  }
}

export async function searchPlaces(keywords, {
  city,
  types,
  limit = 5,
} = {}) {
  const args = { keywords }
  if (city) args.city = city
  if (types) args.types = types
  return searchPoiResults('maps_text_search', args, { limit, fillLocation: true })
}

export async function searchNearbyPlaces({
  keywords,
  location,
  radius,
  limit = 5,
} = {}) {
  const args = { location }
  if (keywords) args.keywords = keywords
  if (radius) args.radius = String(radius)
  return searchPoiResults('maps_around_search', args, { limit })
}

async function getPoiLocation(id) {
  const text = extractText(await callMcp('maps_search_detail', { id }))
  if (!text) return null
  try {
    return JSON.parse(text).location || null
  } catch {
    return null
  }
}

export async function drivingRoute(origin, destination, strategy = 0) {
  const startedAt = Date.now()
  const url = new URL('https://restapi.amap.com/v3/direction/driving')
  url.searchParams.set('origin', origin)
  url.searchParams.set('destination', destination)
  url.searchParams.set('key', key())
  url.searchParams.set('extensions', 'all')
  url.searchParams.set('strategy', String(strategy))
  const response = await fetchWithRetry(url, {}, { beforeAttempt: waitForDrivingRequest })
  assertSuccessfulResponse(response, '路线服务')
  const data = await response.json()
  if (data.status !== '1') {
    emitCall({
      name: 'maps_direction_driving',
      arguments: { origin, destination },
      duration_ms: Date.now() - startedAt,
      result: `错误: ${data.info}`,
    })
    return null
  }
  const path = data.route?.paths?.[0]
  if (!path) return null
  const rawSegments = path.steps?.flatMap(step => (
    Array.isArray(step.tmcs)
      ? step.tmcs.filter(item => item?.polyline).map(item => ({
          status: item.status || '未知',
          distance: Number.parseInt(item.distance, 10) || 0,
          polyline: item.polyline,
        }))
      : []
  )) || []
  const trafficSegments = rawSegments.reduce((segments, item) => {
    const previous = segments.at(-1)
    if (previous?.status === item.status) {
      previous.distance += item.distance
      previous.polyline = `${previous.polyline};${item.polyline}`
    } else {
      segments.push({ ...item })
    }
    return segments
  }, [])
  const distance = Number.parseInt(path.distance, 10) || 0
  const duration = Number.parseInt(path.duration, 10) || 0
  emitCall({
    name: 'maps_direction_driving',
    arguments: { origin, destination },
    duration_ms: Date.now() - startedAt,
    result: `${(distance / 1_000).toFixed(1)}km, ${Math.ceil(duration / 60)}分钟`,
  })
  return {
    distance,
    duration,
    polyline: path.steps?.map(step => step.polyline).filter(Boolean).join(';') || '',
    trafficSegments,
  }
}

export async function getWeather(city = '杭州') {
  const text = extractText(await callMcp('maps_weather', { city }))
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const today = parsed.forecasts?.[0]
    if (!today) return parsed
    return {
      city: parsed.city || city,
      date: today.date,
      dayweather: today.dayweather,
      nightweather: today.nightweather,
      daytemp: today.daytemp,
      nighttemp: today.nighttemp,
      daywind: today.daywind,
      nightwind: today.nightwind,
      daypower: today.daypower,
      nightpower: today.nightpower,
      forecasts: parsed.forecasts || [],
    }
  } catch {
    return { city, raw: text }
  }
}
