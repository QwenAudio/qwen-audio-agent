import { createHash } from 'node:crypto'

/** Stable model-facing reference; backend authorization IDs stay private. */
export function permissionReference(value) {
  const id = String(value || '').trim()
  if (!id) return ''
  return `permission_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`
}
