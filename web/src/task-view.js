import { t } from './i18n.js'

export function phaseForTask(task) {
  if (task.status === 'completed') {
    return ['pending', 'delivering'].includes(task.notificationStatus)
      ? 'responding'
      : 'completed'
  }
  if (task.status === 'failed') return 'failed'
  if (task.status === 'cancelled') return 'cancelled'
  if (task.status === 'queued') return 'queued'
  if (task.status === 'delegated') return 'delegated'
  if (task.status === 'finalizing') return 'finalizing'
  if (task.status === 'cancelling') return 'cancelling'
  if (['working', 'auth_required', 'active'].includes(task.workState)) {
    return 'running'
  }
  return 'running'
}

export function taskIsActive(task) {
  return ['submitted', 'working', 'auth_required', 'active']
    .includes(task?.workState)
}

export function taskNeedsPresentation(task) {
  if (taskIsActive(task)) return true
  return (
    ['completed', 'failed'].includes(task?.status)
    && ['pending', 'delivering'].includes(task?.notificationStatus)
  )
}

export function removeDeliveredTask(tasks, taskId) {
  return tasks.filter(task => task.id !== taskId)
}

export function taskDeliverySettled(task) {
  return (
    ['completed', 'failed'].includes(task?.status)
    && task?.notificationStatus === 'delivered'
  )
}

export function removeTaskInPhase(tasks, taskId, phase) {
  return tasks.filter(task => (
    task.id !== taskId || task.phase !== phase
  ))
}

export function taskLabel(task) {
  if (task.authorization?.status === 'pending') return t('等待你的确认')
  if (task.phase === 'failed') return t('处理失败')
  if (task.phase === 'cancelled') return t('已取消')
  if (task.phase === 'disconnected') return t('连接已中断')
  if (task.phase === 'queued') return t('排队中')
  if (task.phase === 'delegated') return t('进行中')
  if (task.phase === 'finalizing') return t('正在整理结果')
  if (task.phase === 'cancelling') return t('正在取消')
  if (task.phase === 'completed') return t('处理完成')
  if (task.phase === 'responding') return t('正在回复')
  return t('进行中')
}

function latestVisibleActivity(activity = []) {
  const visible = activity.filter(item => (
    item
    && item.tool !== 'invalid'
  ))
  const activeTool = visible.findLast(item => (
    item.kind === 'tool'
    && !['completed', 'failed'].includes(item.status)
  ))
  if (activeTool) return activeTool
  const activePlan = visible.findLast(
    item => item.kind === 'plan' && item.status === 'running',
  )
  if (activePlan) return activePlan
  return visible.findLast(item => item.kind === 'tool')
    || visible.findLast(item => item.kind === 'plan')
    || null
}

export function taskDetail(task) {
  if (task.authorization?.status === 'pending') {
    return task.authorization.summary || t('后台正在请求执行权限')
  }
  if (task.error) return task.error
  if (task.phase === 'cancelled') return t('这项工作已停止')
  if (task.phase === 'queued') return task.objective
  if (task.phase === 'finalizing') return t('项目结果已返回，协调 Agent 正在整理')
  if (task.phase === 'cancelling') return t('正在等待后台确认停止')
  if (task.phase === 'responding') return t('结果已经返回，正在准备语音回复')
  if (task.phase === 'completed') return task.result || t('结果已经发送')
  if (task.phase === 'disconnected') return t('正在等待与后台重新连接')
  const message = String(task.message || '').trim()
  if (message) return message.slice(0, 300)

  const activity = latestVisibleActivity(task.activity)
  if (!activity) return task.phase === 'delegated'
    ? t('进行中')
    : task.objective || t('正在执行任务')
  if (activity.kind === 'plan') {
    const count = activity.total > 0
      ? `${activity.completed}/${activity.total}`
      : ''
    return [count, activity.detail].filter(Boolean).join(' · ')
      || t('正在执行任务')
  }
  if (activity.kind === 'tool') {
    if (activity.label) return activity.label
    if (activity.category === 'image') return t('正在生成图片')
    if (activity.category === 'search') return t('正在查询相关信息')
    if (activity.category === 'read') return t('正在读取相关内容')
    if (activity.category === 'write') return t('正在修改内容')
    const hint = `${activity.tool || ''} ${activity.detail || ''}`.toLowerCase()
    if (/image|图片|图像/.test(hint)) return t('正在生成图片')
    if (/search|web|fetch|搜索|查询/.test(hint)) return t('正在查询相关信息')
    if (/read|glob|grep|list|读取|查找/.test(hint)) return t('正在读取相关内容')
    return activity.status === 'completed'
      ? t('一个处理步骤已完成，正在继续')
      : t('正在执行任务')
  }
  return task.objective
}

export function taskView(task, previous = {}) {
  return {
    ...previous,
    id: task.id,
    ...(
      task.kind !== undefined || previous.kind !== undefined
        ? { kind: task.kind !== undefined ? task.kind : previous.kind }
        : {}
    ),
    objective: task.objective,
    ...(
      task.createdAt !== undefined || previous.createdAt !== undefined
        ? {
            createdAt: task.createdAt !== undefined
              ? task.createdAt
              : previous.createdAt,
          }
        : {}
    ),
    ...(
      task.startedAt !== undefined || previous.startedAt !== undefined
        ? {
            startedAt: task.startedAt !== undefined
              ? task.startedAt
              : previous.startedAt,
          }
        : {}
    ),
    elapsedMs: task.elapsedMs || 0,
    phase: phaseForTask(task),
    turnId: task.turnId,
    result: Object.hasOwn(task, 'result')
      ? task.result
      : previous.result,
    ...(
      Object.hasOwn(task, 'message') || Object.hasOwn(previous, 'message')
        ? {
            message: Object.hasOwn(task, 'message')
              ? task.message
              : previous.message,
          }
        : {}
    ),
    ...(
      Object.hasOwn(task, 'activity') || Object.hasOwn(previous, 'activity')
        ? { activity: task.activity || previous.activity || [] }
        : {}
    ),
    ...(
      Object.hasOwn(task, 'delegation')
      || Object.hasOwn(previous, 'delegation')
        ? {
            delegation: Object.hasOwn(task, 'delegation')
              ? task.delegation
              : previous.delegation,
          }
        : {}
    ),
    error: task.error,
    ...(
      Object.hasOwn(task, 'authorization')
      || Object.hasOwn(previous, 'authorization')
        ? {
            authorization: Object.hasOwn(task, 'authorization')
              ? task.authorization
              : previous.authorization,
          }
        : {}
    ),
  }
}
