import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.localStorage = {
  getItem: key => (key === 'qwen-audio-lang' ? 'zh-CN' : null),
}
import {
  phaseForTask,
  removeDeliveredTask,
  removeTaskInPhase,
  taskDeliverySettled,
  taskDetail,
  taskIsActive,
  taskNeedsPresentation,
  taskLabel,
  taskView,
} from '../src/task-view.js'

test('presents every active coordinator request as one frontend processing phase', () => {
  assert.equal(phaseForTask({
    status: 'queued',
    workState: 'submitted',
  }), 'queued')
  assert.equal(phaseForTask({
    status: 'running',
    workState: 'working',
  }), 'running')
  assert.equal(taskLabel({ phase: 'queued' }), '排队中')
  assert.equal(taskLabel({ phase: 'running' }), '进行中')
  assert.equal(taskLabel({ phase: 'delegated' }), '进行中')
  assert.equal(taskLabel({ phase: 'finalizing' }), '正在整理结果')
  assert.equal(taskLabel({ phase: 'cancelling' }), '正在取消')
  assert.equal(phaseForTask({
    status: 'finalizing',
    workState: 'working',
  }), 'finalizing')
  assert.equal(phaseForTask({
    status: 'cancelling',
    workState: 'working',
  }), 'cancelling')
  assert.equal(phaseForTask({
    status: 'delegated',
    workState: 'working',
  }), 'delegated')
  assert.equal(taskDetail({
    phase: 'delegated',
    delegation: { title: '已有项目' },
  }), '进行中')
  assert.equal(taskDetail({
    phase: 'delegated',
    objective: '开发游戏',
    activity: [{
      kind: 'tool',
      status: 'running',
      category: 'write',
    }],
  }), '正在修改内容')
  assert.equal(phaseForTask({
    status: 'cancelled',
  }), 'cancelled')
  assert.equal(taskLabel({ phase: 'cancelled' }), '已取消')
  assert.equal(taskDetail({ phase: 'cancelled' }), '这项工作已停止')
  assert.equal(taskIsActive({ workState: 'submitted' }), true)
  assert.equal(taskIsActive({ workState: 'working' }), true)
  assert.equal(taskIsActive({ workState: 'auth_required' }), true)
  assert.equal(taskIsActive({ workState: 'completed' }), false)
})

test('separates backend completion from realtime result delivery', () => {
  assert.equal(phaseForTask({
    status: 'completed',
    notificationStatus: 'pending',
  }), 'responding')
  assert.equal(phaseForTask({
    status: 'completed',
    notificationStatus: 'delivering',
  }), 'responding')
  assert.equal(phaseForTask({
    status: 'completed',
    notificationStatus: 'delivered',
  }), 'completed')
})

test('a late delivery receipt cannot resurrect a removed task card', () => {
  const active = [
    { id: 'other', phase: 'running' },
    { id: 'delivered', phase: 'responding' },
  ]
  assert.deepEqual(removeDeliveredTask(active, 'delivered'), [
    { id: 'other', phase: 'running' },
  ])
  assert.deepEqual(removeDeliveredTask([], 'delivered'), [])
})

test('reconnect reconciliation recognizes terminal tasks already delivered', () => {
  assert.equal(taskDeliverySettled({
    status: 'completed',
    notificationStatus: 'delivered',
  }), true)
  assert.equal(taskDeliverySettled({
    status: 'completed',
    notificationStatus: 'delivering',
  }), false)
  assert.equal(taskDeliverySettled({
    status: 'running',
    notificationStatus: 'delivered',
  }), false)
  assert.equal(taskNeedsPresentation({
    status: 'running',
    workState: 'working',
  }), true)
  assert.equal(taskNeedsPresentation({
    status: 'completed',
    notificationStatus: 'pending',
  }), true)
  assert.equal(taskNeedsPresentation({
    status: 'failed',
    notificationStatus: 'delivering',
  }), true)
  assert.equal(taskNeedsPresentation({
    status: 'completed',
    notificationStatus: 'delivered',
  }), false)
})

test('removes a transient task only while it remains in the expected phase', () => {
  const tasks = [
    { id: 'cancelled', phase: 'cancelled' },
    { id: 'reused', phase: 'running' },
  ]
  assert.deepEqual(removeTaskInPhase(tasks, 'cancelled', 'cancelled'), [
    { id: 'reused', phase: 'running' },
  ])
  assert.deepEqual(removeTaskInPhase(tasks, 'reused', 'cancelled'), tasks)
})

test('shows stable user-facing progress instead of raw backend commands', () => {
  assert.equal(taskDetail({
    phase: 'running',
    objective: '画一只小狗',
    activity: [{
      kind: 'tool',
      tool: 'bash',
      status: 'running',
      category: 'image',
      detail: '',
    }],
  }), '正在生成图片')
  assert.equal(taskDetail({
    phase: 'responding',
    result: '小狗图片已经生成',
  }), '结果已经返回，正在准备语音回复')
  assert.equal(taskDetail({
    phase: 'completed',
    result: '小狗图片已经生成',
  }), '小狗图片已经生成')
})

test('shows ACP plan progress without exposing protocol details', () => {
  assert.equal(taskDetail({
    phase: 'running',
    objective: 'Build a game',
    activity: [{
      id: 'acp-plan',
      kind: 'plan',
      status: 'running',
      detail: 'Implement gameplay',
      completed: 1,
      total: 3,
    }],
  }), '1/3 · Implement gameplay')
})

test('shows protocol Agent messages ahead of tool activity', () => {
  assert.equal(taskDetail({
    phase: 'running',
    message: '已经读完资料，正在整理关键结论。',
    activity: [{
      kind: 'tool',
      status: 'running',
      category: 'read',
    }],
  }), '已经读完资料，正在整理关键结论。')

  const updated = taskView({
    id: 'task-message',
    status: 'running',
    objective: '整理资料',
    message: '正在核对来源',
  })
  assert.equal(updated.message, '正在核对来源')
})

test('keeps backend-internal thinking, mode, and session state out of cards', () => {
  assert.equal(taskDetail({
    phase: 'running',
    objective: '开发一个贪吃蛇游戏',
    activity: [{ kind: 'thinking', status: 'running' }],
  }), '开发一个贪吃蛇游戏')
  assert.equal(taskDetail({
    phase: 'running',
    activity: [{ kind: 'thinking', status: 'running' }],
  }), '正在执行任务')
  assert.equal(taskDetail({
    phase: 'running',
    activity: [{ kind: 'mode', status: 'updated', mode: 'plan' }],
  }), '正在执行任务')
  assert.equal(taskDetail({
    phase: 'running',
    objective: '构建演示',
    activity: [{
      kind: 'session',
      status: 'updated',
      title: 'Build the demo',
    }],
  }), '构建演示')
})

test('prefers the active ACP step over later text and completed tools', () => {
  assert.equal(taskDetail({
    phase: 'running',
    objective: 'Build a game',
    activity: [
      { kind: 'tool', status: 'completed', label: 'Inspect project' },
      { kind: 'tool', status: 'pending', label: 'Implement gameplay' },
      { kind: 'text', status: 'running' },
    ],
  }), 'Implement gameplay')
})

test('reconciles a disconnected card with its real terminal state', () => {
  assert.deepEqual(taskView({
    id: 'job-1',
    objective: '查天气',
    elapsedMs: 1200,
    status: 'completed',
    notificationStatus: 'delivered',
    turnId: 'voice-100-1',
    result: '晴天',
    error: null,
  }, {
    id: 'job-1',
    phase: 'disconnected',
  }), {
    id: 'job-1',
    objective: '查天气',
    elapsedMs: 1200,
    phase: 'completed',
    turnId: 'voice-100-1',
    result: '晴天',
    error: null,
  })
})

test('does not expose backend session routing in the frontend task view', () => {
  const backendRef = {
    provider: 'opencode',
    sessionId: 'ses_visible',
    url: 'http://127.0.0.1:4096/project/session/ses_visible',
  }
  const running = taskView({
    id: 'task-visible',
    status: 'running',
    objective: '整理报告',
    backendRef,
  })
  const completed = taskView({
    id: 'task-visible',
    status: 'completed',
    objective: '整理报告',
    notificationStatus: 'delivered',
  }, running)

  assert.equal(completed.backendRef, undefined)
  assert.equal(completed.type, undefined)
})

test('preserves task kind and timing across partial progress events', () => {
  const accepted = taskView({
    id: 'task-work',
    kind: 'work',
    status: 'queued',
    objective: '开发游戏',
    createdAt: 1_000,
    startedAt: null,
  })
  const progress = taskView({
    id: 'task-work',
    status: 'running',
    objective: '开发游戏',
    elapsedMs: 800,
  }, accepted)

  assert.equal(progress.kind, 'work')
  assert.equal(progress.createdAt, 1_000)
  assert.equal(progress.startedAt, null)
})
