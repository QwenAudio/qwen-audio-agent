let callListener = null

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

async function callMcp(toolName, args) {
  const startedAt = Date.now()
  const response = await fetch(`https://mcp.amap.com/mcp?key=${key()}`, {
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
  const contentType = response.headers.get('content-type') || ''
  let result = null
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const data = JSON.parse(line.slice(5).trim())
        if (data.result) {
          result = data.result
          break
        }
      } catch {}
    }
  } else {
    const data = await response.json()
    if (!data.result?.isError) result = data.result || null
  }
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
  const args = { keywords }
  if (city) args.city = city
  const text = extractText(await callMcp('maps_text_search', args))
  if (!text) return null
  try {
    const poi = JSON.parse(text).pois?.[0]
    if (poi?.location) return { location: poi.location, name: poi.name }
    if (poi?.id) {
      const location = await getPoiLocation(poi.id)
      if (location) return { location, name: poi.name }
    }
  } catch {}
  return null
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
  const data = await fetch(url).then(response => response.json())
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
