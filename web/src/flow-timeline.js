// Turning a flow's events into rows a person can read top to bottom.
//
// A swimlane was the first attempt and it failed on real data: events cluster
// into the first seconds and then nothing happens for a minute, so blocks piled
// on top of each other at the left edge. Chronological rows do not have that
// problem, and reading order matches the order things happened, which is the
// question the page exists to answer.
//
// Kept apart from the component so this arithmetic is testable without a DOM,
// which is how the rest of this codebase separates presentation logic too.
export const FLOW_LAYERS = Object.freeze([
  { id: 'frontstage', label: '前台', hint: 'Realtime 语音模型' },
  { id: 'gateway', label: '协调层', hint: 'Gateway 与任务状态机' },
  { id: 'backend', label: '后台', hint: '后台 Agent 与 ACP 协议' },
  { id: 'delegated', label: '委派', hint: '独立的后台会话' },
])

export function flowLayerLabel(id) {
  return FLOW_LAYERS.find(layer => layer.id === id)?.label || id
}

// Internal event names are precise but not language. The page shows both: the
// sentence so it can be skimmed, the raw type so it can be grepped.
const EVENT_LABELS = {
  'turn.started': '用户开始这一轮',
  'user.said': '用户说',
  'frontstage.tool': '前台调用工具',
  'task.accepted': '任务已接受',
  'task.scheduled': '任务已排期',
  'task.created': '任务已创建',
  'task.running': '任务开始执行',
  'task.delegated': '任务转为独立会话',
  'task.finalizing': '任务收尾',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务被取消',
  'task.notification.delivered': '结果已播报',
  'task.notification.dismissed': '结果被跳过',
  'task.permission.requested': '向用户请求授权',
  'task.permission.resolved': '授权已答复',
  'coordinator.turn.start': '协调轮次开始',
  'coordinator.answered': '后台给出回答',
  'vision.described': '视觉模型识别图像',
  'vision.failed': '视觉模型调用失败',
  'assistant.said': '前台回复用户',
  'backend.reasoning': '后台模型推理',
  'backend.output': '后台模型输出',
  'backend.tool': '后台执行工具',
  'backend.tool.failed': '后台工具失败',
  'backend.plan': '后台制定计划',
  'coordinator.turn.end': '协调轮次结束',
  'acp.request': '向后台发起调用',
  'acp.response': '后台返回结果',
  'acp.error': '后台调用出错',
  'acp.permission.requested': '后台请求授权',
  'acp.permission.auto': '授权被自动放行',
}

export function flowEventLabel(type) {
  return EVENT_LABELS[type] || type
}

// What is worth showing without a click. Chosen per event kind, because the
// useful field differs: a call needs its method, a permission needs which run
// it was attributed to.
export function flowEventSummary(event) {
  const detail = event?.detail || {}
  const parts = []
  if (detail.model) parts.push(detail.model)
  if (detail['用户原话']) parts.push(detail['用户原话'])
  if (detail['回复内容']) parts.push(detail['回复内容'])
  if (detail.origin) parts.push(detail.origin)
  if (detail.endpoint) parts.push(detail.endpoint)
  if (detail.text) parts.push(detail.text)
  if (detail.prompt) parts.push(detail.prompt)
  if (detail.arguments) parts.push(detail.arguments)
  if (detail.method) parts.push(detail.method)
  if (detail.name) parts.push(detail.name)
  if (detail.tool) parts.push(detail.tool)
  if (detail.target) parts.push(detail.target)
  if (detail.note) parts.push(detail.note)
  if (typeof detail.steps === 'number') parts.push(`${detail.steps} 步`)
  if (detail.source) parts.push(detail.source)
  if (detail.status && !detail.method) parts.push(detail.status)
  if (typeof detail.elapsedMs === 'number') parts.push(`${detail.elapsedMs}ms`)
  if (detail.reason) parts.push(detail.reason)
  if (detail.attributedToRun) parts.push(`归属 ${detail.attributedToRun}`)
  if (detail.listenerStillAttached === true) parts.push('监听仍挂着')
  if (detail.error) parts.push(String(detail.error))
  if (detail.status === 'failed' && !detail.error) parts.push('失败')
  return parts.join(' · ')
}

export function anomalyIndexMap(anomalies = []) {
  const map = new Map()
  for (const anomaly of anomalies) {
    for (const index of anomaly.eventIndexes || []) {
      const existing = map.get(index)
      // Errors win over warnings so a row is never downgraded by a second,
      // milder finding.
      if (!existing || (existing.severity !== 'error' && anomaly.severity === 'error')) {
        map.set(index, anomaly)
      }
    }
  }
  return map
}

export function formatOffset(offsetMs) {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return '0.0s'
  return `${(offsetMs / 1000).toFixed(1)}s`
}

// A gap worth pointing out. Most rows follow within milliseconds; the long
// waits are where a failure usually hides, so they get their own marker rather
// than being left for the reader to subtract.
const GAP_THRESHOLD_MS = 2000

export function buildFlowRows(flow, anomalies = []) {
  const events = Array.isArray(flow?.events) ? flow.events : []
  if (events.length === 0) {
    return { rows: [], durationMs: 0, startedAt: 0, layerCounts: {} }
  }
  const startedAt = events[0].at
  const accused = anomalyIndexMap(anomalies)
  const layerCounts = {}
  const rows = []

  events.forEach((event, index) => {
    layerCounts[event.layer] = (layerCounts[event.layer] || 0) + 1
    const previous = events[index - 1]
    const gapMs = previous ? event.at - previous.at : 0
    const anomaly = accused.get(index)
    const last = rows[rows.length - 1]
    // In a merged session timeline the turn changes partway through. Marking
    // the boundary is what keeps a conversation readable while still showing
    // that an event from an earlier turn arrived during a later one.
    const turnId = event.flowId || ''
    const turnChanged = Boolean(previous) && turnId !== (previous.flowId || '')

    // Consecutive identical events collapse into one row with a count. Nothing
    // is learned from reading the same line twice.
    if (last
      && last.type === event.type
      && last.layer === event.layer
      && last.turnId === turnId
      && !anomaly
      && !last.severity
      && gapMs < GAP_THRESHOLD_MS) {
      last.repeated += 1
      last.lastIndex = index
      last.durationMs = event.at - last.at
      return
    }

    rows.push({
      index,
      lastIndex: index,
      repeated: 1,
      layer: event.layer,
      layerLabel: flowLayerLabel(event.layer),
      type: event.type,
      label: flowEventLabel(event.type),
      summary: flowEventSummary(event),
      at: event.at,
      offsetMs: event.at - startedAt,
      gapMs: gapMs >= GAP_THRESHOLD_MS ? gapMs : 0,
      durationMs: 0,
      turnId,
      turnChanged,
      taskId: event.taskId || '',
      sessionId: event.sessionId || '',
      detail: event.detail,
      severity: anomaly?.severity || '',
      anomalyRule: anomaly?.rule || '',
    })
  })

  return {
    rows,
    startedAt,
    durationMs: events[events.length - 1].at - startedAt,
    layerCounts,
    turnCount: new Set(events.map(event => event.flowId).filter(Boolean)).size,
  }
}
