export function taskProgressFromEvent(event) {
  if (!String(event?.type || '').startsWith('task.')) return null
  const task = event.task || {}
  const activity = Array.isArray(task.activity) ? task.activity.at(-1) : null
  const category = activity?.category || task.kind || 'task'
  return {
    domain: category,
    stage: activity?.status || task.status || event.type.slice(5),
    message: event.message || activity?.message || task.message || '',
    taskId: task.id,
  }
}

export function taskProgressFingerprint(progress) {
  return [
    progress?.domain,
    progress?.stage,
    progress?.message,
  ].map(value => String(value || '').trim()).join('\u0000')
}

export function rememberTaskProgress(progress, seen, maxTasks = 200) {
  if (!(seen instanceof Map)) throw new TypeError('seen must be a Map')
  const fingerprint = taskProgressFingerprint(progress)
  if (!fingerprint.replaceAll('\u0000', '')) return false
  const key = String(progress?.taskId || fingerprint)
  if (seen.get(key) === fingerprint) return false
  seen.delete(key)
  seen.set(key, fingerprint)
  while (seen.size > maxTasks) seen.delete(seen.keys().next().value)
  return true
}
