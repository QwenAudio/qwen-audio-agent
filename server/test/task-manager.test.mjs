import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

test('uses one short task id across the public and execution layers', () => {
  const manager = new TaskManager()
  const first = manager.create({ objective: 'A', ownerId: 'owner' })
  const second = manager.create({ objective: 'B', ownerId: 'owner' })

  assert.equal(first.id, 'task_1')
  assert.equal(second.id, 'task_2')
  assert.notEqual(first.id, second.id)
  assert.equal(manager.getByTaskId('task_2', { ownerId: 'owner' }).id, second.id)
})

test('cycles short task ids after 99999 without reusing retained records', () => {
  const manager = new TaskManager()
  manager.nextTaskNumber = 99_999

  const last = manager.create({ objective: 'last', ownerId: 'owner' })
  const first = manager.create({ objective: 'first', ownerId: 'owner' })

  assert.equal(last.id, 'task_99999')
  assert.equal(first.id, 'task_1')
  assert.notEqual(last.id, first.id)
})

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

test('moves updated backend activity to the end so recency stays correct', async () => {
  const manager = new TaskManager()
  const task = manager.create({
    objective: 'A',
    ownerId: 'owner',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.activity',
        activity: { id: 'thinking', kind: 'thinking', status: 'running' },
      })
      onEvent({
        type: 'backend.activity',
        activity: { id: 'tool', kind: 'tool', status: 'running' },
      })
      onEvent({
        type: 'backend.activity',
        activity: { id: 'thinking', kind: 'thinking', status: 'running' },
      })
      return { content: 'done' }
    },
  })

  await manager.wait(task.id)
  assert.deepEqual(
    manager.get(task.id).activity.map(activity => activity.id),
    ['tool', 'thinking'],
  )
})

test('coalesces streaming backend activity and messages into bounded progress events', async () => {
  const manager = new TaskManager({ progressEventIntervalMs: 60_000 })
  const events = []
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: 'A',
    ownerId: 'owner',
    runner: async (_objective, { onEvent }) => {
      for (let index = 1; index <= 100; index += 1) {
        onEvent({
          type: 'backend.activity',
          activity: {
            id: 'thinking',
            kind: 'thinking',
            status: 'running',
          },
        })
        onEvent({
          type: 'backend.message',
          message: `正在处理 ${index}`,
        })
      }
      return { content: 'done' }
    },
  })

  await manager.wait(task.id)

  assert.equal(
    events.filter(event => event.type === 'task.progress').length,
    0,
  )
  assert.equal(
    events.filter(event => event.type === 'task.updated').length,
    1,
  )
  assert.equal(manager.get(task.id).message, '正在处理 100')
})

test('persists normalized backend messages and artifacts as Task updates', async () => {
  const manager = new TaskManager()
  const events = []
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '生成报告',
    ownerId: 'owner',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.message',
        message: '已完成资料整理。',
      })
      onEvent({
        type: 'backend.artifact',
        artifact: {
          artifactId: 'report',
          name: '报告',
          parts: [{ text: '# 结果', mediaType: 'text/markdown' }],
        },
      })
      return { content: '完成' }
    },
  })

  await manager.wait(task.id)

  const completed = manager.get(task.id)
  assert.equal(completed.message, '已完成资料整理。')
  assert.equal(completed.artifacts[0].artifactId, 'report')
  assert.equal(
    events.filter(event => event.type === 'task.updated').length,
    2,
  )
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
          taskId: 'work_one',
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
  const pending = manager.get(task.id)
  assert.equal(pending.authorization.id, 'auth_one')
  assert.equal(pending.authorization.taskId, task.id)
  assert.equal(pending.workState, 'auth_required')
  assert.equal(Number.isFinite(pending.authorization.createdAt), true)
  assert.equal(
    events.some(event => event.type === 'task.permission.requested'),
    true,
  )
  release()
  await manager.wait(task.id)
})

test('keeps a backend input request on the same active work until resumed', async () => {
  const manager = new TaskManager()
  let release
  const events = []
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.input.requested',
        input: {
          id: 'input_one',
          status: 'pending',
          mode: 'text',
          prompt: '使用中文还是英文？',
        },
      })
      await new Promise(resolve => { release = resolve })
      onEvent({
        type: 'backend.input.resolved',
        input: {
          id: 'input_one',
          status: 'accepted',
          mode: 'text',
          prompt: '使用中文还是英文？',
        },
      })
      return { content: '中文报告已完成' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).workState, 'input_required')
  assert.equal(manager.get(task.id).status, 'running')
  assert.ok(events.some(event => event.type === 'task.input.requested'))
  release()
  await manager.wait(task.id)
  assert.equal(manager.get(task.id).status, 'completed')
  assert.equal(manager.get(task.id).inputRequest, null)
  assert.ok(events.some(event => event.type === 'task.input.resolved'))
})

test('drops stale permissions restored on terminal work', () => {
  const manager = new TaskManager({
    store: {
      load: () => [{
        id: 'task_90',
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

  assert.equal(manager.get('task_90').authorization, null)
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
            inline: {
              title: '已有项目',
              format: 'markdown',
              content: '项目已经接着做了。',
            },
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
  assert.equal(delegated.workState, 'working')
  assert.equal(delegated.delegation.status, 'running')
  assert.equal(delegated.delegation.title, '已有项目')
  assert.equal('presentation' in delegated.delegation, false)
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

test('keeps a delivered task reachable the next day but drops it after the window', async () => {
  // 语音场景里「周五派的活周一问」很常见，隔天还能查到状态是这个 TTL 的用途。
  // 这里不写死毫秒数，只锁「跨天仍在、超窗即走」这条语义。
  const manager = new TaskManager()
  const day = 86_400_000
  const [next, expired] = await Promise.all(['隔天问', '很久以前'].map(async objective => {
    const task = manager.create({
      objective,
      ownerId: 'owner',
      sessionId: 'voice',
      runner: async () => ({ content: '结果' }),
    })
    await manager.wait(task.id)
    return task
  }))
  // 通知已送达才会走 terminalTtlMs；未送达的走 pendingNotificationTtlMs
  for (const task of [next, expired]) {
    manager.tasks.get(task.id).notificationStatus = 'delivered'
  }
  // 用 2 天前而不是 1 天前：判断是 age > ttl，1 天前正好卡在等号上，
  // 24 小时与 3 天两种配置都不会删，那样这条测试就锁不住任何东西。
  manager.tasks.get(next.id).completedAt = Date.now() - day * 2
  manager.tasks.get(expired.id).completedAt = Date.now() - day * 4

  manager.prune()
  const ids = manager.list({ ownerId: 'owner' }).map(task => task.taskId ?? task.id)
  assert.ok(ids.includes(next.id), '隔天的活必须还能查到状态')
  assert.ok(!ids.includes(expired.id), '超出保留窗的活应当被清掉')
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

test('publishes standard artifacts from a completed result', async () => {
  const events = []
  const manager = new TaskManager()
  manager.subscribe(event => events.push(event))
  const task = manager.create({
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({
      content: '报告已经生成',
      artifacts: [{
        artifactId: 'report',
        name: '报告',
        parts: [{ text: '# 完成', mediaType: 'text/markdown' }],
      }],
      metadata: {
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
  assert.equal('presentation' in completed, false)
  assert.deepEqual(completed.artifacts, [{
    artifactId: 'report',
    name: '报告',
    parts: [{ text: '# 完成', mediaType: 'text/markdown' }],
  }])
  assert.deepEqual(
    events.find(event => event.type === 'task.completed')
      ?.task.artifacts,
    completed.artifacts,
  )
})

test('drops legacy presentation while preserving standard artifacts on restore', () => {
  let saved = []
  const manager = new TaskManager({
    store: {
      load: () => [{
        id: 'task_92',
        status: 'completed',
        objective: '旧任务',
        ownerId: 'owner',
        sessionId: 'voice',
        result: '旧结果',
        artifacts: [{
          artifactId: 'legacy-result',
          parts: [{ text: 'const done = true', mediaType: 'text/plain' }],
        }],
        resultMetadata: {
          decision: {
            presentation: {
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

  const restored = manager.get('task_92')
  assert.equal('presentation' in restored, false)
  manager.persist()
  assert.deepEqual(saved[0].artifacts, restored.artifacts)
  assert.equal('presentation' in saved[0], false)
  assert.equal('resultMetadata' in saved[0], false)
})
