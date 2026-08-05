import assert from 'node:assert/strict'
import test from 'node:test'
import { AnnouncementManager } from '../src/voice/announcement/announcement-manager.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for announcement state')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function replayHarness({ lastAnnouncement = null } = {}) {
  const outputs = []
  const handler = new ToolCallHandler({
    taskManager: new TaskManager(),
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts: new TurnTranscripts({ waitMs: 5 }),
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    coordinator: { run: async () => ({ content: '完成', metadata: {} }) },
    getLastAnnouncement: () => lastAnnouncement,
  })
  return { outputs, handler }
}

test('onSpoken reports the delivered announcement text once spoken', async () => {
  const spoken = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      speak: async () => ({ completed: true }),
    }),
    announceIntoContext: false,
    batchWindowMs: 1,
    onSpoken: (text, taskIds) => spoken.push({ text, taskIds }),
  })

  manager.completed({
    id: 'work-replay',
    objective: '生成周报',
    result: '周报已生成并保存',
    turnId: 'turn-one',
    completedAt: Date.now(),
  })
  await waitFor(() => spoken.length === 1)

  assert.match(spoken[0].text, /周报已生成并保存/)
  assert.deepEqual(spoken[0].taskIds, ['work-replay'])
  manager.close()
})

test('onSpoken does not fire when delivery fails', async () => {
  const spoken = []
  let attempts = 0
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      speak: async () => {
        attempts += 1
        return { completed: false }
      },
    }),
    announceIntoContext: false,
    batchWindowMs: 1,
    retryBaseMs: 5,
    onSpoken: text => spoken.push(text),
  })

  manager.completed({
    id: 'work-blocked',
    objective: '生成周报',
    result: '内容',
    turnId: 'turn-one',
    completedAt: Date.now(),
  })
  await waitFor(() => attempts >= 1)

  assert.equal(spoken.length, 0)
  manager.close()
})

test('replay tool returns the last spoken announcement', async () => {
  const { outputs, handler } = replayHarness({
    lastAnnouncement: { text: '[COMPLETE] 周报已生成并保存', at: 1_000 },
  })
  await handler.handle({
    call_id: 'call-replay',
    name: 'replay_last_announcement',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(outputs.length, 1)
  const [, output] = outputs[0]
  assert.equal(output.status, 'ok')
  assert.match(output.content, /周报已生成并保存/)
  assert.equal(output.spoken_at, 1_000)
})

test('replay tool reports empty before any announcement was spoken', async () => {
  const { outputs, handler } = replayHarness()
  await handler.handle({
    call_id: 'call-replay-empty',
    name: 'replay_last_announcement',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(outputs.length, 1)
  const [, output] = outputs[0]
  assert.equal(output.status, 'empty')
})
