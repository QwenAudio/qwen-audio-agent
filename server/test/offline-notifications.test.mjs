import assert from 'node:assert/strict'
import test from 'node:test'
import { installOfflineNotifications } from '../src/app/offline-notifications.mjs'

function harness(initialTask) {
  let listener
  let current = { ...initialTask }
  const messages = []
  const timers = []
  const taskManager = {
    subscribe(callback) {
      listener = callback
      return () => { listener = null }
    },
    get() {
      return current
    },
  }
  installOfflineNotifications({
    taskManager,
    parentPort: { postMessage: message => messages.push(message) },
    delayMs: 100,
    setTimer(callback) {
      timers.push(callback)
      return { unref() {} }
    },
  })
  return {
    emit: event => listener(event),
    runTimer: () => timers.shift()?.(),
    setTask: value => { current = { ...value } },
    messages,
  }
}

test('drops delayed progress after the task has completed', () => {
  const task = {
    id: 'work-1',
    ownerId: 'owner',
    objective: 'build',
    workState: 'working',
    status: 'running',
  }
  const testHarness = harness(task)
  testHarness.emit({
    type: 'task.progress.check',
    ownerId: 'owner',
    task,
    message: 'still working',
  })
  testHarness.setTask({
    ...task,
    workState: 'completed',
    status: 'completed',
    notificationStatus: 'pending',
  })
  testHarness.runTimer()
  assert.deepEqual(testHarness.messages, [])
})

test('delivers delayed progress only while the task remains active', () => {
  const task = {
    id: 'work-1',
    ownerId: 'owner',
    objective: 'build',
    workState: 'working',
    status: 'running',
  }
  const testHarness = harness(task)
  testHarness.emit({
    type: 'task.progress.check',
    ownerId: 'owner',
    task,
    message: 'still working',
  })
  testHarness.runTimer()
  assert.equal(testHarness.messages.length, 1)
  assert.equal(testHarness.messages[0].task.status, 'progress')
})

test('delivers terminal notification only while its claim is pending', () => {
  const task = {
    id: 'work-1',
    ownerId: 'owner',
    objective: 'build',
    result: 'done',
    error: null,
    workState: 'completed',
    status: 'completed',
    notificationStatus: 'pending',
  }
  const testHarness = harness(task)
  testHarness.emit({
    type: 'task.notification.pending',
    ownerId: 'owner',
    task,
  })
  testHarness.runTimer()
  assert.equal(testHarness.messages.length, 1)

  testHarness.emit({
    type: 'task.notification.pending',
    ownerId: 'owner',
    task,
  })
  testHarness.setTask({ ...task, notificationStatus: 'delivered' })
  testHarness.runTimer()
  assert.equal(testHarness.messages.length, 1)
})
