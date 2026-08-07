import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.localStorage = {
  getItem: key => (key === 'qwen-audio-lang' ? 'zh-CN' : null),
}
import {
  phaseForTask,
  removeDeliveredTask,
  removeTaskInPhase,
  taskDetail,
  taskLabel,
  taskView,
} from '../src/task-view.js'

test('presents every active coordinator request as one frontend processing phase', () => {
  assert.equal(phaseForTask({
    status: 'queued',
    workState: 'active',
  }), 'queued')
  assert.equal(phaseForTask({
    status: 'running',
    workState: 'active',
  }), 'running')
  assert.equal(taskLabel({ phase: 'queued' }), '正在处理')
  assert.equal(taskLabel({ phase: 'running' }), '正在处理')
  assert.equal(taskLabel({ phase: 'delegated' }), '项目正在执行')
  assert.equal(taskLabel({ phase: 'finalizing' }), '正在整理结果')
  assert.equal(taskLabel({ phase: 'cancelling' }), '正在取消')
  assert.equal(phaseForTask({
    status: 'finalizing',
    workState: 'active',
  }), 'finalizing')
  assert.equal(phaseForTask({
    status: 'cancelling',
    workState: 'active',
  }), 'cancelling')
  assert.equal(phaseForTask({
    status: 'delegated',
    workState: 'active',
  }), 'delegated')
  assert.equal(taskDetail({
    phase: 'delegated',
    delegation: { title: '已有项目' },
  }), '正在继续处理：已有项目')
  assert.equal(phaseForTask({
    status: 'cancelled',
  }), 'cancelled')
  assert.equal(taskLabel({ phase: 'cancelled' }), '已取消')
  assert.equal(taskDetail({ phase: 'cancelled' }), '这项工作已停止')
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
