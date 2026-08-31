const STATE_METADATA = new Set(['version', 'updatedAt'])

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
