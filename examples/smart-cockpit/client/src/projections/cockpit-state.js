const STATE_METADATA = new Set(['version', 'updatedAt'])

function emptyNavigationSession(navigation) {
  return {
    ...navigation,
    status: 'idle',
    destination: null,
    destinationLocation: null,
    waypoints: [],
    waypointLocations: [],
    route: null,
    map: { markers: [], polylines: [] },
  }
}

export function hasActiveNavigationSession(state) {
  const navigation = state?.navigation
  if (!navigation) return false
  return navigation.status !== 'idle'
    || Boolean(navigation.destination)
    || Boolean(navigation.route)
}

export function clearNavigationSession(state) {
  if (!hasActiveNavigationSession(state)) return state
  return {
    ...state,
    navigation: emptyNavigationSession(state.navigation),
  }
}

export function applyCockpitStateUpdate(previous, event) {
  const next = event?.state
  if (!previous || !next || !Array.isArray(event.changed)) return next

  const changed = new Set(event.changed)
  const reconciled = { ...next }
  for (const key of Object.keys(next)) {
    if (!STATE_METADATA.has(key) && !changed.has(key) && key in previous) {
      reconciled[key] = previous[key]
    }
  }
  return reconciled
}
