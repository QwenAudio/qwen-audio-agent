import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTaskActive,
  isTaskCancellable,
  isTaskTerminal,
  publicTask,
  TaskScope,
  TaskStatus,
  transitionTask,
} from '../src/task/task-state.mjs'

test('centralizes active, cancellable, and terminal task phases', () => {
  assert.equal(isTaskActive(TaskStatus.QUEUED), true)
  assert.equal(isTaskActive(TaskStatus.CANCELLING), true)
  assert.equal(isTaskCancellable(TaskStatus.SCHEDULED), true)
  assert.equal(isTaskCancellable(TaskStatus.CANCELLING), false)
  assert.equal(isTaskTerminal(TaskStatus.COMPLETED), true)
  assert.equal(isTaskTerminal(TaskStatus.RUNNING), false)
})

test('defaults old records to user work and preserves explicit system jobs', () => {
  assert.equal(publicTask({
    id: 'old-work',
    status: TaskStatus.QUEUED,
    activity: [],
  }).scope, TaskScope.USER)
  assert.equal(publicTask({
    id: 'system-job',
    scope: TaskScope.SYSTEM,
    status: TaskStatus.QUEUED,
    activity: [],
  }).scope, TaskScope.SYSTEM)
})

test('accepts valid transitions and rejects backwards or terminal transitions', () => {
  const work = { status: TaskStatus.QUEUED }
  transitionTask(work, TaskStatus.RUNNING)
  transitionTask(work, TaskStatus.DELEGATED)
  transitionTask(work, TaskStatus.FINALIZING)
  transitionTask(work, TaskStatus.COMPLETED)

  assert.equal(work.status, TaskStatus.COMPLETED)
  assert.throws(
    () => transitionTask(work, TaskStatus.RUNNING),
    /Invalid task transition/,
  )
  assert.throws(
    () => transitionTask({ status: 'unknown' }, TaskStatus.RUNNING),
    /Unknown task transition/,
  )
})

test('projects an active task into standard artifacts without legacy result metadata', () => {
  const projected = publicTask({
    id: 'work-one',
    taskId: 'job_1',
    status: TaskStatus.RUNNING,
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    createdAt: 10,
    startedAt: 40,
    elapsedMs: 0,
    activity: [],
    artifacts: [{
      artifactId: 'report',
      name: '报告',
      parts: [{ text: '# 完成', mediaType: 'text/markdown' }],
    }],
    resultMetadata: {
      presentation: {
        inline: { title: '报告', format: 'markdown', content: '# 完成' },
      },
      backendRef: { sessionId: 'private-session' },
    },
    notificationStatus: 'none',
  }, { now: 100 })

  assert.equal(projected.workState, 'working')
  assert.equal(projected.elapsedMs, 60)
  assert.equal('presentation' in projected, false)
  assert.deepEqual(projected.artifacts, [{
    artifactId: 'report',
    name: '报告',
    parts: [{ text: '# 完成', mediaType: 'text/markdown' }],
  }])
  assert.equal('resultMetadata' in projected, false)
})

test('projects pending authorization as the public auth_required state', () => {
  const projected = publicTask({
    id: 'work-auth',
    taskId: 'job_2',
    status: TaskStatus.RUNNING,
    objective: '执行命令',
    createdAt: 1,
    activity: [],
    authorization: {
      id: 'auth_1',
      status: 'pending',
      summary: '执行 npm test',
      createdAt: 2,
    },
  })
  assert.equal(projected.workState, 'auth_required')
  assert.equal(projected.authorization.taskId, 'work-auth')
})

test('projects a backend question without completing the active task', () => {
  const projected = publicTask({
    id: 'task_3',
    status: TaskStatus.RUNNING,
    objective: '生成报告',
    createdAt: 1,
    activity: [],
    inputRequest: {
      id: 'input_1',
      status: 'pending',
      kind: 'input',
      mode: 'text',
      prompt: '报告使用中文还是英文？',
      createdAt: 2,
    },
  })
  assert.equal(projected.workState, 'input_required')
  assert.equal(projected.status, TaskStatus.RUNNING)
  assert.equal(projected.inputRequest.taskId, 'task_3')
})
