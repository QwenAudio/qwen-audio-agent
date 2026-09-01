export function navigationRouteView(navigation) {
  if (!['navigating', 'preview'].includes(navigation?.status)) return null
  const route = navigation.route
  if (!route) return null
  const legs = Array.isArray(route.legs) ? route.legs : []
  const polylines = legs
    .map(leg => leg?.polyline)
    .filter(Boolean)
    .map((polyline, index) => (
      index === 0 ? polyline : polyline.split(';').slice(1).join(';')
    ))
    .filter(Boolean)
  const waypointLocations = (navigation.map?.markers || [])
    .filter(marker => marker?.role === 'waypoint')
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map(marker => marker.location)
    .filter(Boolean)
  return {
    status: navigation.status,
    destination: navigation.destination || '',
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
    route: navigation?.route || null,
    map: {
      markers: (navigation?.map?.markers || []).map(marker => ({
        role: marker?.role,
        index: marker?.index,
        location: marker?.location,
      })),
    },
  })
}
