const DESKTOP_TASK_PHASES = new Set([
  'scheduled',
  'queued',
  'running',
  'delegated',
  'finalizing',
  'cancelling',
  'responding',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
])

const SCHEDULED_TASK_KINDS = new Set(['reminder', 'scheduled_task'])

function desktopTaskSortKey(task) {
  return Number(
    task.phase === 'scheduled' ? task.schedule?.at : task.createdAt,
  ) || 0
}

export function desktopTaskCards(tasks = []) {
  return tasks
    .filter(task => (
      DESKTOP_TASK_PHASES.has(task.phase)
      && (
        task.kind === undefined
        || task.kind === 'work'
        || SCHEDULED_TASK_KINDS.has(task.kind)
      )
    ))
    .sort((left, right) => (
      desktopTaskSortKey(left) - desktopTaskSortKey(right)
    ))
}

export function desktopTaskElapsedSeconds(task, now = Date.now()) {
  const elapsed = task.startedAt && ![
    'completed',
    'failed',
    'cancelled',
  ].includes(task.phase)
    ? Math.max(task.elapsedMs || 0, now - task.startedAt)
    : task.elapsedMs || 0
  return Math.max(0, Math.round(elapsed / 1000))
}

export function desktopTaskElapsedLabel(task, now = Date.now()) {
  const seconds = desktopTaskElapsedSeconds(task, now)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}
