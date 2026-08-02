import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AnnouncementManager,
  formatWorkResults,
} from '../src/voice/announcement/announcement-manager.mjs'

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for announcement state')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('formats only final work results for realtime presentation', () => {
  const text = formatWorkResults([{
    event: 'task.completed',
    taskId: 'work-one',
    objective: '生成图片',
    status: 'completed',
    result: '图片已生成',
  }])
  assert.match(text, /^\[COMPLETE\]/)
  assert.match(text, /work_id: work-one/)
  assert.match(text, /图片已生成/)
  assert.doesNotMatch(text, /permission|lifecycle|session/i)
})

test('passes backend-provided error content through for realtime interpretation', () => {
  const backendResult = JSON.stringify({
    code: 'Provider.InternalError',
    message: 'backend supplied detail',
  })
  const text = formatWorkResults([{
    event: 'task.completed',
    taskId: 'work-provider-error',
    objective: '执行后台任务',
    status: 'completed',
    result: backendResult,
  }])

  assert.match(text, /^\[COMPLETE\]/)
  assert.match(text, /type: task\.completed/)
  assert.match(text, /Provider\.InternalError/)
  assert.match(text, /backend supplied detail/)
})

test('waits while duplex speech blocks delivery', async () => {
  let blocked = true
  let spoken = 0
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => {
        spoken += 1
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => blocked,
    batchWindowMs: 0,
  })
  manager.completed({
    id: 'work-one',
    objective: '处理',
    result: '完成',
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(spoken, 0)
  blocked = false
  manager.flush()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(spoken, 1)
  manager.close()
})

test('batches nearby completed work into one realtime response', async () => {
  const inputs = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async input => {
        inputs.push(input)
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 2,
  })
  manager.completed({ id: 'one', objective: 'A', result: 'A done' })
  manager.completed({ id: 'two', objective: 'B', result: 'B done' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(inputs.length, 1)
  assert.match(inputs[0], /A done/)
  assert.match(inputs[0], /B done/)
  manager.close()
})

test('delivers bounded announcement batches in order and confirms each task once', async () => {
  const inputs = []
  const delivered = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async input => {
        inputs.push(input)
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => false,
    maxBatchItems: 1,
    batchWindowMs: 0,
    onDelivered: taskIds => delivered.push(...taskIds),
  })

  manager.completed({ id: 'first', objective: '第一个', result: '结果一' })
  manager.completed({ id: 'second', objective: '第二个', result: '结果二' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(inputs.length, 1)
  assert.match(inputs[0], /work_id: first/)

  manager.confirmMany(['first'])
  manager.confirmMany(['first'])
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(inputs.length, 2)
  assert.match(inputs[1], /work_id: second/)

  manager.confirmMany(['second'])
  manager.confirmMany(['second'])
  assert.deepEqual(delivered, ['first', 'second'])
  manager.close()
})

test('does not mark a generated result delivered until playback starts', async () => {
  const delivered = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => ({ completed: true, contextInjected: true }),
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    onDelivered: taskIds => delivered.push(...taskIds),
  })
  manager.completed({ id: 'work-one', objective: '处理', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(delivered, [])
  manager.confirmMany(['work-one'])
  assert.deepEqual(delivered, ['work-one'])
  manager.close()
})

test('dismisses an active result after user interruption without retrying it', async () => {
  let attempts = 0
  const delivered = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => {
        attempts += 1
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 1,
    acknowledgementTimeoutMs: 5,
    onDelivered: taskIds => delivered.push(...taskIds),
  })
  manager.completed({ id: 'work-one', objective: '播报结果', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 2))

  manager.dismissActive()
  manager.retryMany(['work-one'])
  await new Promise(resolve => setTimeout(resolve, 15))

  assert.equal(attempts, 1)
  assert.deepEqual(delivered, ['work-one'])
  assert.equal(manager.activeBatch, null)
  assert.equal(manager.pending.size, 0)
  manager.close()
})

test('retries a generated result when playback acknowledgement times out', async () => {
  let attempts = 0
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => {
        attempts += 1
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 1,
    acknowledgementTimeoutMs: 5,
  })
  manager.completed({ id: 'work-one', objective: '处理', result: '完成' })
  await waitFor(() => attempts >= 2)
  assert.ok(attempts >= 2)
  manager.close()
})

test('never retries an announcement while its audio is still queued or playing', async () => {
  let blocked = true
  let attempts = 0
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => {
        attempts += 1
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => blocked,
    batchWindowMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 1,
    acknowledgementTimeoutMs: 5,
  })

  // Queue while idle, then model the audio entering the client playback queue
  // before generation completes.
  blocked = false
  manager.completed({ id: 'work-one', objective: '讲故事', result: '很长的故事' })
  await new Promise(resolve => setTimeout(resolve, 2))
  blocked = true
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(attempts, 1)

  manager.confirmMany(['work-one'])
  blocked = false
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(attempts, 1)
  manager.close()
})

test('releases claimed notifications when a voice client is superseded', async () => {
  const released = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async () => ({ completed: true, contextInjected: true }),
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    onRelease: taskIds => released.push(...taskIds),
  })
  manager.completed({ id: 'work-one', objective: '处理', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 5))

  manager.pause()

  assert.deepEqual(released, ['work-one'])
  assert.equal(manager.activeBatch, null)
  assert.equal(manager.pending.size, 0)
  manager.close()
})

test('ignores a late generation completion after the voice client is paused', async () => {
  let finishGeneration
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: () => new Promise(resolve => {
        finishGeneration = resolve
      }),
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
  })
  manager.completed({ id: 'work-one', objective: '处理', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.pause()
  finishGeneration({ completed: true, contextInjected: true })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(manager.activeBatch, null)
  assert.equal(manager.acknowledgementTimer, null)
  manager.close()
})

test('a paused delivery cannot disturb the replacement voice client delivery', async () => {
  const completions = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: () => new Promise(resolve => completions.push(resolve)),
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
  })
  manager.completed({ id: 'work-one', objective: '第一个', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 5))
  manager.pause()
  manager.completed({ id: 'work-two', objective: '第二个', result: '完成' })
  await new Promise(resolve => setTimeout(resolve, 5))

  completions[0]({ completed: true, contextInjected: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.delivering, true)
  assert.deepEqual(manager.activeBatch.taskIds, ['work-two'])

  completions[1]({ completed: true, contextInjected: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.activeBatch.responseCompleted, true)
  manager.close()
})

test('releases a poison batch after bounded retries so later results can proceed', async () => {
  const inputs = []
  const released = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async input => {
        inputs.push(input)
        return input.includes('坏结果')
          ? { completed: false }
          : { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxRetryAttempts: 1,
    onRelease: taskIds => released.push(...taskIds),
  })
  manager.completed({ id: 'poison', objective: '坏任务', result: '坏结果' })
  await waitFor(() => inputs.some(input => input.includes('坏结果')))
  manager.completed({ id: 'healthy', objective: '好任务', result: '好结果' })
  await waitFor(() => (
    released.includes('poison')
    && inputs.some(input => input.includes('好结果'))
  ))
  manager.confirmMany(['healthy'])
  manager.close()
})
