function clean(value) {
  return String(value || '').trim()
}

/**
 * Project one canonical Gateway Task into the semantic instruction seen by a
 * backend Agent. Routing, lifecycle, owner, and protocol fields remain on the
 * Task object for adapters and never become model-visible text.
 */
export function backendInstructionFromWork(work = {}) {
  const explicit = clean(work.instruction)
  if (explicit) return explicit
  return clean(work.objective || work.message)
}
