import { taskDetail, taskLabel } from './task-view.js'

function formatElapsed(ms = 0) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${remainder}s`
}

function truncateObjective(text = '', max = 40) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export default function DesktopTaskPanel({
  task,
  backendLabel,
  onCancel,
  onOpenDetails,
}) {
  if (!task) return null

  const phase = task.phase || task.status
  const normalizedTask = { ...task, phase }
  const isRunning = ['queued', 'running', 'delegated', 'finalizing'].includes(phase)
  const isFailed = phase === 'failed'
  const isCompleted = phase === 'completed'

  let statusClass = ''
  if (isRunning || phase === 'running') statusClass = 'running'
  if (isCompleted) statusClass = 'completed'
  if (isFailed) statusClass = 'failed'
  if (task.authorization?.status === 'pending') statusClass = 'pending'

  return (
    <aside
      className={`desktop-task-panel ${statusClass}`}
      onClick={onOpenDetails}
      title="点击打开任务详情"
    >
      <div className="desktop-task-panel-header">
        <span className="desktop-task-panel-agent">
          {backendLabel || 'Agent'} {isRunning ? '正在执行' : taskLabel(normalizedTask)}
        </span>
        <span className="desktop-task-panel-time">{formatElapsed(task.elapsedMs)}</span>
      </div>
      <button
        type="button"
        className="desktop-task-panel-title-button"
        onClick={event => {
          event.stopPropagation()
          onOpenDetails?.(event)
        }}
      >
        {truncateObjective(task.objective)}
      </button>
      <div className="desktop-task-panel-detail">
        {taskDetail(normalizedTask)}
      </div>
      <div className="desktop-task-panel-footer">
        <div className="desktop-task-panel-progress">
          <div className="desktop-task-panel-progress-bar" />
        </div>
        {isRunning && (
          <button
            type="button"
            className="desktop-task-panel-cancel"
            onClick={event => {
              event.stopPropagation()
              onCancel?.(task.id)
            }}
            title="取消任务"
          >
            取消
          </button>
        )}
      </div>
    </aside>
  )
}
