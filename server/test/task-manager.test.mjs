import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

test('serializes work in the same coordinator lane while accepting immediately', async () => {
  const manager = new TaskManager()
  const order = []
  let releaseFirst
  const first = manager.create({
    objective: 'A',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async (_objective, { onEvent }) => {
      order.push('A:start')
      onEvent({
        type: 'backend.activity',
        activity: { id: 'tool', kind: 'tool', tool: 'read', status: 'running' },
      })
      await new Promise(resolve => {
        releaseFirst = resolve
      })
      order.push('A:end')
      return { content: 'A done' }
    },
  })
  const second = manager.create({
    objective: 'B',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      order.push('B:start')
      return { content: 'B done' }
    },
  })
  assert.equal(first.status, 'queued')
  assert.equal(second.status, 'queued')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(first.id).status, 'running')
  assert.equal(manager.get(second.id).status, 'queued')
  assert.equal(manager.get(first.id).activity[0].tool, 'read')
  releaseFirst()
  await Promise.all([manager.wait(first.id), manager.wait(second.id)])
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start'])
})

test('runs a hidden control query before queued ordinary work', async () => {
  const manager = new TaskManager()
  const order = []
  let releaseFirst
  const first = manager.create({
    objective: '正在执行的普通任务',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      order.push('first')
      await new Promise(resolve => { releaseFirst = resolve })
      return { content: 'first done' }
    },
  })
  const ordinary = manager.create({
    objective: '排队的普通任务',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      order.push('ordinary')
      return { content: 'ordinary done' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const query = manager.create({
    kind: 'control',
    parentWorkId: 'delegated-work',
    priority: 100,
    objective: '高优先级状态查询',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      order.push('query')
      return { content: 'query done' }
    },
  })

  assert.equal(manager.list({ ownerId: 'owner' }).some(task => (
    task.id === query.id
  )), false)
  assert.equal(manager.list({
    ownerId: 'owner',
    includeControl: true,
  }).some(task => task.id === query.id), true)

  releaseFirst()
  await Promise.all([
    manager.wait(first.id),
    manager.wait(query.id),
    manager.wait(ordinary.id),
  ])
  assert.deepEqual(order, ['first', 'query', 'ordinary'])
})

test('publishes a bounded pending permission on the active work', async () => {
  const manager = new TaskManager()
  let release
  const events = []
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '运行检查',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.permission.requested',
        permission: {
          id: 'auth_one',
          workId: 'work_one',
          status: 'pending',
          category: 'bash',
          summary: '运行命令：npm test',
        },
      })
      await new Promise(resolve => { release = resolve })
      return { content: '完成' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).authorization.id, 'auth_one')
  assert.equal(
    events.some(event => event.type === 'task.permission.requested'),
    true,
  )
  release()
  await manager.wait(task.id)
})

test('drops stale permissions restored on terminal work', () => {
  const manager = new TaskManager({
    store: {
      load: () => [{
        id: 'work-complete',
        status: 'completed',
        objective: '检查目录',
        ownerId: 'owner',
        sessionId: 'voice',
        authorization: {
          id: 'auth-stale',
          status: 'pending',
          summary: 'List directory',
        },
      }],
      save: () => {},
    },
  })

  assert.equal(manager.get('work-complete').authorization, null)
})

test('keeps delegated work active while releasing its coordinator lane', async () => {
  const manager = new TaskManager()
  let finish
  let secondStarted = false
  const events = []
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '继续已有项目',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.delegated',
        delegation: {
          id: 'run-one',
          sessionId: 'ses-target',
          title: '已有项目',
          directory: '/project',
          presentation: {
            speech: '项目已经接着做了。',
            inline: null,
          },
        },
      })
      await new Promise(resolve => { finish = resolve })
      return { content: '目标结果' }
    },
  })
  const second = manager.create({
    objective: '查询任务状态',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      secondStarted = true
      return { content: '仍在执行' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))

  const delegated = manager.get(task.id)
  assert.equal(delegated.status, 'delegated')
  assert.equal(delegated.workState, 'active')
  assert.equal(delegated.delegation.status, 'running')
  assert.equal(delegated.delegation.title, '已有项目')
  assert.equal(
    delegated.delegation.presentation.speech,
    '项目已经接着做了。',
  )
  assert.ok(events.some(event => event.type === 'task.delegated'))
  assert.equal(secondStarted, true)
  assert.equal(manager.get(second.id).status, 'completed')

  finish()
  await Promise.all([manager.wait(task.id), manager.wait(second.id)])
  assert.equal(manager.get(task.id).status, 'completed')
  assert.equal(manager.get(task.id).result, '目标结果')
})

test('cancels queued work without starting it', async () => {
  const manager = new TaskManager({ maxConcurrent: 1 })
  let releaseFirst
  let secondStarted = false
  const first = manager.create({
    objective: 'A',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => new Promise(resolve => {
      releaseFirst = resolve
    }),
  })
  const second = manager.create({
    objective: 'B',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => {
      secondStarted = true
      return { content: 'B done' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(second.id).status, 'queued')
  assert.equal(
    (await manager.cancel(second.id, { ownerId: 'owner' })).status,
    'cancelled',
  )
  releaseFirst({ content: 'A done' })
  await manager.wait(first.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)
  assert.equal(manager.get(second.id).notificationStatus, 'none')
})

test('aborts running work and only then releases its coordinator lane', async () => {
  const manager = new TaskManager()
  let aborted = false
  let secondStarted = false
  let confirmCancellation
  const first = manager.create({
    objective: 'A',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    canceler: async ({ abort }) => {
      abort()
      await new Promise(resolve => { confirmCancellation = resolve })
    },
    runner: async (_objective, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(signal.reason)
      }, { once: true })
    }),
  })
  const second = manager.create({
    objective: 'B',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async () => {
      secondStarted = true
      return { content: 'B done' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const cancellation = manager.cancel(first.id, { ownerId: 'owner' })
  assert.equal(manager.get(first.id).status, 'cancelling')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true)
  assert.equal(secondStarted, false)
  confirmCancellation()
  await cancellation
  assert.equal(manager.get(first.id).status, 'cancelled')
  await manager.wait(second.id)
  assert.equal(secondStarted, true)
})

test('claims a completed result once and releases an unplayed claim', async () => {
  const manager = new TaskManager()
  const task = manager.create({
    objective: '完成工作',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '结果' }),
  })
  await manager.wait(task.id)
  const claimed = manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'voice-one',
  })
  assert.equal(claimed.length, 1)
  manager.releaseNotificationClaims([task.id], { claimantId: 'voice-one' })
  assert.equal(manager.get(task.id).notificationStatus, 'pending')
})

test('a new voice session can deliver unfinished results for the same owner', async () => {
  const manager = new TaskManager()
  const task = manager.create({
    objective: '跨会话工作',
    ownerId: 'owner',
    sessionId: 'old-voice-session',
    runner: async () => ({ content: '结果' }),
  })
  await manager.wait(task.id)
  const claimed = manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'new-voice-session',
    includeOtherSessions: true,
    claimantId: 'new-client',
  })
  assert.equal(claimed[0].id, task.id)
})

test('prefers the originating session unless cross-session recovery is explicit', async () => {
  const manager = new TaskManager()
  const task = manager.create({
    objective: '原会话结果',
    ownerId: 'owner',
    sessionId: 'original',
    runner: async () => ({ content: '结果' }),
  })
  await manager.wait(task.id)
  assert.equal(manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'other',
    claimantId: 'other-client',
  }).length, 0)
  assert.equal(manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'original',
    claimantId: 'original-client',
  })[0].id, task.id)
})

test('reclaims an expired notification delivery lease', async () => {
  const manager = new TaskManager({ notificationClaimTtlMs: 1 })
  const task = manager.create({
    objective: '租约恢复',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '结果' }),
  })
  await manager.wait(task.id)
  manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'stale-client',
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  const reclaimed = manager.claimNotifications({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'new-client',
  })
  assert.equal(reclaimed[0].id, task.id)
})

test('does not evict pending notifications to satisfy delivered history limit', async () => {
  const manager = new TaskManager({ maxTerminalTasksPerOwner: 1 })
  const tasks = ['一', '二'].map(objective => manager.create({
    objective,
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '结果' }),
  }))
  await Promise.all(tasks.map(task => manager.wait(task.id)))
  manager.prune()
  assert.equal(manager.list({ ownerId: 'owner' }).length, 2)
})

test('reuses a persisted submission key instead of running duplicate work', async () => {
  let saved = []
  let runs = 0
  const store = {
    load: () => saved,
    save: tasks => {
      saved = structuredClone(tasks)
    },
  }
  const first = new TaskManager({ store })
  const task = first.create({
    objective: '只执行一次',
    ownerId: 'owner',
    sessionId: 'voice',
    submissionKey: 'delegation:voice:turn-one',
    runner: async () => {
      runs += 1
      return { content: '完成' }
    },
  })
  await first.wait(task.id)

  const restored = new TaskManager({ store })
  const duplicate = restored.create({
    objective: '不要再次执行',
    ownerId: 'owner',
    sessionId: 'voice',
    submissionKey: 'delegation:voice:turn-one',
    runner: async () => {
      runs += 1
      return { content: '重复' }
    },
  })
  assert.equal(duplicate.id, task.id)
  assert.equal(duplicate.reused, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 1)
})

test('listing tasks does not rewrite unchanged persistent state', async () => {
  let saves = 0
  const manager = new TaskManager({
    store: {
      load: () => [],
      save: () => {
        saves += 1
      },
    },
  })
  const task = manager.create({
    objective: '查询',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '结果' }),
  })
  await manager.wait(task.id)
  const before = saves
  manager.list({ ownerId: 'owner' })
  manager.list({ ownerId: 'owner' })
  assert.equal(saves, before)
})

test('publishes only presentation metadata from a completed result', async () => {
  const events = []
  const manager = new TaskManager()
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({
      content: '报告已经生成',
      metadata: {
        presentation: {
          speech: '报告已经生成。',
          inline: {
            title: '报告',
            format: 'markdown',
            content: '# 完成',
          },
        },
        backendRef: {
          sessionId: 'backend-session',
          directory: '/private/project',
        },
        delegation: {
          id: 'delegation-id',
          sessionId: 'target-session',
        },
      },
    }),
  })

  const completed = await manager.wait(task.id)
  assert.deepEqual(completed.resultMetadata, {
    presentation: {
      speech: '报告已经生成。',
      inline: {
        title: '报告',
        format: 'markdown',
        content: '# 完成',
      },
    },
  })
  assert.deepEqual(
    events.find(event => event.type === 'task.completed')
      ?.task.resultMetadata,
    completed.resultMetadata,
  )
})

test('projects legacy decision presentation when restoring a task', () => {
  let saved = []
  const manager = new TaskManager({
    store: {
      load: () => [{
        id: 'legacy-work',
        status: 'completed',
        objective: '旧任务',
        ownerId: 'owner',
        sessionId: 'voice',
        result: '旧结果',
        resultMetadata: {
          decision: {
            presentation: {
              speech: '旧任务已经完成。',
              inline: {
                title: '旧结果',
                format: 'code',
                content: 'const done = true',
              },
            },
          },
          backendRef: {
            sessionId: 'legacy-session',
            directory: '/private/legacy',
          },
        },
      }],
      save: tasks => { saved = structuredClone(tasks) },
    },
  })

  const restored = manager.get('legacy-work')
  assert.deepEqual(restored.resultMetadata, {
    presentation: {
      speech: '旧任务已经完成。',
      inline: {
        title: '旧结果',
        format: 'code',
        content: 'const done = true',
      },
    },
  })
  manager.persist()
  assert.deepEqual(saved[0].resultMetadata, restored.resultMetadata)
})
