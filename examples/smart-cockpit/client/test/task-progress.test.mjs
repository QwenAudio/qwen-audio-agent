import assert from 'node:assert/strict'
import test from 'node:test'
import {
  rememberTaskProgress,
  taskProgressFromEvent,
} from '../src/projections/task-progress.js'

function taskEvent(type, {
  id = 'task-one',
  status = 'working',
  activityStatus = 'working',
  message = '正在执行座舱能力：navigation_route_query',
} = {}) {
  return {
    type,
    task: {
      id,
      kind: 'navigation',
      status,
      message,
      activity: [{
        category: 'navigation',
        status: activityStatus,
        message,
      }],
    },
  }
}

test('projects the latest task activity for the debug panel', () => {
  assert.deepEqual(taskProgressFromEvent(taskEvent('task.updated')), {
    domain: 'navigation',
    stage: 'working',
    message: '正在执行座舱能力：navigation_route_query',
    taskId: 'task-one',
  })
  assert.equal(taskProgressFromEvent({ type: 'voice.state' }), null)
})

test('deduplicates one semantic progress update across Task lifecycle events', () => {
  const seen = new Map()
  const updated = taskProgressFromEvent(taskEvent('task.updated'))
  const replayed = taskProgressFromEvent(taskEvent('task.finalizing'))
  assert.equal(rememberTaskProgress(updated, seen), true)
  assert.equal(rememberTaskProgress(replayed, seen), false)

  const completed = taskProgressFromEvent(taskEvent('task.completed', {
    status: 'completed',
    activityStatus: 'completed',
    message: '已开始导航到汽车西站',
  }))
  assert.equal(rememberTaskProgress(completed, seen), true)
  assert.equal(rememberTaskProgress(completed, seen), false)

  const anotherTask = taskProgressFromEvent(taskEvent('task.completed', {
    id: 'task-two',
    status: 'completed',
    activityStatus: 'completed',
    message: '已开始导航到汽车西站',
  }))
  assert.equal(rememberTaskProgress(anotherTask, seen), true)
})
