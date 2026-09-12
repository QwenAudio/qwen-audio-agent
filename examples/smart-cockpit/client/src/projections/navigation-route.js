export function navigationRouteView(navigation) {
  if (!['navigating', 'preview'].includes(navigation?.status)) return null
  const route = navigation.route
  if (!route) return null
  const legs = Array.isArray(route.legs) ? route.legs : []
  const markers = navigation.map?.markers || []
  const polylines = legs
    .map(leg => leg?.polyline)
    .filter(Boolean)
    .map((polyline, index) => (
      index === 0 ? polyline : polyline.split(';').slice(1).join(';')
    ))
    .filter(Boolean)
  const waypointMarkers = markers
    .filter(marker => marker?.role === 'waypoint')
    .sort((left, right) => Number(left.index) - Number(right.index))
  const waypointLocations = waypointMarkers
    .map(marker => marker.location)
    .filter(Boolean)
  const waypointNames = waypointMarkers
    .map(marker => marker.name || navigation.waypoints?.[Number(marker.index)])
    .filter(Boolean)
  const destinationMarker = markers.find(marker => marker?.role === 'destination')
  return {
    status: navigation.status,
    destination: navigation.destination || '',
    destinationLocation: navigation.destinationLocation || destinationMarker?.location || '',
    waypoints: waypointNames.length
      ? waypointNames
      : (Array.isArray(navigation.waypoints) ? navigation.waypoints.filter(Boolean) : []),
    distKm: route.distKm,
    durationMin: route.durationMin,
    arrivalStr: route.arrival,
    polyline: polylines.join(';'),
    trafficSegments: legs.flatMap(leg => (
      Array.isArray(leg?.trafficSegments) ? leg.trafficSegments : []
    )),
    waypointLocations,
  }
}

export function navigationRouteKey(navigation) {
  return JSON.stringify({
    status: navigation?.status || 'idle',
    destination: navigation?.destination || '',
    destinationLocation: navigation?.destinationLocation || '',
    waypoints: navigation?.waypoints || [],
    route: navigation?.route || null,
    map: {
      markers: (navigation?.map?.markers || []).map(marker => ({
        role: marker?.role,
        index: marker?.index,
        name: marker?.name,
        location: marker?.location,
      })),
    },
  })
}

export function navigationProgressMarker(progress) {
  const item = progress?.item
  if (
    progress?.domain !== 'navigation'
    || !['destination_locked', 'waypoint_locked'].includes(progress?.stage)
    || !item
    || typeof item !== 'object'
    || !item.location
  ) return null
  const role = item.role === 'waypoint' ? 'waypoint' : 'destination'
  return {
    role,
    index: role === 'waypoint' ? Number(item.index) || 0 : null,
    name: String(item.name || '').trim(),
    location: item.location,
  }
}

export function navigationRouteCompletionViewMode(route) {
  return route?.polyline ? 'overview' : 'destination'
}
