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
  const viaMarker = navigation.map?.markers?.find(marker => marker?.role === 'via')
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
    viaLocation: viaMarker?.location || null,
  }
}
