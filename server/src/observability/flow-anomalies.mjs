// Turning a wall of events into "the problem is here".
//
// A timeline alone still asks the reader to know what correct looks like. These
// rules encode the failures that have actually cost time on this project, so
// the page can point at them. Every rule is a pure function over a flow's
// events and returns the indexes it accuses, which is what lets the UI jump
// straight to the evidence.
//
// Rules are deliberately conservative. An observability aid that cries wolf
// gets ignored, and then it is worse than nothing.
const TERMINAL_TASK_EVENTS = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
])

export const DEFAULT_THRESHOLDS = Object.freeze({
  // A permission nobody answers is the symptom of the real bug; a minute is
  // far longer than a human takes to click, and longer than any auto-approval.
  pendingPermissionMs: 60_000,
  // A coordinator turn that has asked the backend nothing for this long is
  // either wedged or waiting on something invisible.
  idleTaskMs: 90_000,
  // Backend calls can legitimately run for minutes, so this is generous.
  pendingRequestMs: 180_000,
})

function at(events, index) {
  return events[index]?.at || 0
}

// A permission request answered for a task that had already finished is the
// bug that started this whole feature: the frontstage will not raise a prompt
// for a task in a terminal state, so the backend waits forever and the model
// ends up telling the user it lacks permission.
function permissionAfterTerminal(events) {
  const found = []
  const terminalAt = new Map()
  events.forEach((event, index) => {
    const taskId = event.taskId
    if (!taskId) return
    if (TERMINAL_TASK_EVENTS.has(event.type) && !terminalAt.has(taskId)) {
      terminalAt.set(taskId, index)
      return
    }
    if (event.type !== 'task.permission.requested') return
    const closedAt = terminalAt.get(taskId)
    if (closedAt === undefined) return
    found.push({
      rule: 'permission-after-terminal',
      severity: 'error',
      eventIndexes: [closedAt, index],
      summary: `审批请求投递到已结束的任务 ${taskId}`,
      detail: `该任务在 ${Math.round((at(events, index) - at(events, closedAt)) / 1000)} 秒前`
        + '就已进入终态。前台不会为已结束的任务弹出授权，因此后端会一直等待，'
        + '最终表现为模型声称没有权限。',
    })
  })
  return found
}

function unansweredPermission(events, { pendingPermissionMs }, now) {
  const answered = new Set()
  for (const event of events) {
    if (event.type !== 'task.permission.resolved') continue
    const id = event.detail?.permissionId
    if (id) answered.add(id)
  }
  const found = []
  events.forEach((event, index) => {
    if (event.type !== 'task.permission.requested') return
    const id = event.detail?.permissionId
    if (id && answered.has(id)) return
    const waited = now - event.at
    if (waited < pendingPermissionMs) return
    found.push({
      rule: 'permission-unanswered',
      severity: 'error',
      eventIndexes: [index],
      summary: '审批请求始终没有得到答复',
      detail: `已等待 ${Math.round(waited / 1000)} 秒。可能是前台没有收到、`
        + '前端没有展示，或者答复被投递到了别处。',
    })
  })
  return found
}

// A task that reached running but never made the backend do anything usually
// means the request never actually left the Gateway.
function idleAfterRunning(events, { idleTaskMs }, now) {
  const found = []
  events.forEach((event, index) => {
    if (event.type !== 'task.running' || !event.taskId) return
    const startedAt = event.at
    const closedAt = events.find((candidate, position) => position > index
      && candidate.taskId === event.taskId
      && TERMINAL_TASK_EVENTS.has(candidate.type))?.at
    const deadline = Math.min(closedAt ?? Infinity, startedAt + idleTaskMs)
    const sawBackend = events.some(candidate => candidate.layer === 'backend'
      && candidate.at >= startedAt
      && candidate.at <= deadline)
    if (sawBackend) return
    // Only complain once the window has actually elapsed; a task that finished
    // quickly without backend traffic was simply answered from cache or state.
    const elapsed = (closedAt ?? now) - startedAt
    if (elapsed < idleTaskMs) return
    found.push({
      rule: 'task-idle',
      severity: 'warn',
      eventIndexes: [index],
      summary: `任务 ${event.taskId} 运行后没有任何后端活动`,
      detail: `${Math.round(elapsed / 1000)} 秒内后端一次调用都没有发生，`
        + '请求可能没有真正离开协调层。',
    })
  })
  return found
}

function requestWithoutResponse(events, { pendingRequestMs }, now) {
  const answered = new Set()
  for (const event of events) {
    if (event.type !== 'acp.response') continue
    const id = event.detail?.rpcId
    if (id !== undefined && id !== null) answered.add(String(id))
  }
  const found = []
  events.forEach((event, index) => {
    if (event.type !== 'acp.request') return
    const id = event.detail?.rpcId
    if (id !== undefined && id !== null && answered.has(String(id))) return
    const waited = now - event.at
    if (waited < pendingRequestMs) return
    found.push({
      rule: 'request-without-response',
      severity: 'warn',
      eventIndexes: [index],
      summary: `后端调用 ${event.detail?.method || '未知方法'} 没有返回`,
      detail: `已等待 ${Math.round(waited / 1000)} 秒。后端可能卡住，`
        + '或者连接已经断开而调用方没有察觉。',
    })
  })
  return found
}

// Sessions outlive a single interaction, so this cannot be derived from the
// flow alone: it needs the set of sessions the Gateway believes it owns. Left
// unset, the rule stays silent rather than guessing.
function unknownSession(events, knownSessionIds) {
  if (!knownSessionIds || knownSessionIds.size === 0) return []
  const found = []
  events.forEach((event, index) => {
    if (event.layer !== 'backend' || !event.sessionId) return
    if (knownSessionIds.has(event.sessionId)) return
    found.push({
      rule: 'unknown-session',
      severity: 'error',
      eventIndexes: [index],
      summary: `事件指向未知会话 ${event.sessionId}`,
      detail: '该会话不在协调层记录的会话集合中，可能是旧会话的残留事件，'
        + '也可能是会话被替换后监听没有解除。',
    })
  })
  return found
}

export function detectFlowAnomalies(flow, {
  thresholds = {},
  knownSessionIds,
  now = Date.now(),
} = {}) {
  const events = Array.isArray(flow?.events) ? flow.events : []
  if (events.length === 0) return []
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const known = knownSessionIds instanceof Set
    ? knownSessionIds
    : (Array.isArray(knownSessionIds) ? new Set(knownSessionIds) : null)

  return [
    ...permissionAfterTerminal(events),
    ...unansweredPermission(events, limits, now),
    ...idleAfterRunning(events, limits, now),
    ...requestWithoutResponse(events, limits, now),
    ...unknownSession(events, known),
    // Earliest evidence first, so reading top to bottom follows the failure.
  ].sort((a, b) => at(events, a.eventIndexes[0]) - at(events, b.eventIndexes[0]))
}
