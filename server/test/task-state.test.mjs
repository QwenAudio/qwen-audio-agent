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

test('projects an active task without leaking private result metadata', () => {
  const projected = publicTask({
    id: 'work-one',
    jobId: 'job_1',
    status: TaskStatus.RUNNING,
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    createdAt: 10,
    startedAt: 40,
    elapsedMs: 0,
    activity: [],
    resultMetadata: {
      presentation: {
        speech: '报告已完成。',
        inline: { title: '报告', format: 'markdown', content: '# 完成' },
      },
      backendRef: { sessionId: 'private-session' },
    },
    notificationStatus: 'none',
  }, { now: 100 })

  assert.equal(projected.workState, 'active')
  assert.equal(projected.elapsedMs, 60)
  assert.deepEqual(projected.resultMetadata, {
    presentation: {
      speech: '报告已完成。',
      inline: { title: '报告', format: 'markdown', content: '# 完成' },
    },
  })
  assert.equal('backendRef' in projected.resultMetadata, false)
})
