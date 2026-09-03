import assert from 'node:assert/strict'
import test from 'node:test'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { BackgroundVisionRuntime } from '../src/vision/background-vision-runtime.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

const FRAME = 'YQ=='

function fixture({ backend = {}, deliveryRuntime = null } = {}) {
  const taskManager = new TaskManager()
  const inputAssets = new InputAssetRegistry()
  const events = []
  const insights = []
  const runtime = new BackgroundVisionRuntime({
    taskManager,
    backendRuntime: {
      describe: () => ({
        capabilities: { inputModes: ['text', 'image'] },
      }),
      run: async (...args) => backend.run?.(...args) || ({
        content: JSON.stringify({ summary: '画面中有一个物体。', confidence: 0.8 }),
      }),
      cancel: async (...args) => backend.cancel?.(...args) || ({ layer: 'backend' }),
    },
    inputAssets,
    ownerId: 'owner',
    sessionId: 'session',
    getFrames: ({ limit } = {}) => [
      { image: FRAME, sequence: 11, capturedAt: 1_000 },
      { image: FRAME, sequence: 12, capturedAt: 2_000 },
    ].slice(-limit),
    getObservationContext: () => ({
      observationId: 'observation_1',
      generation: 3,
    }),
    deliveryRuntime,
    onEvent: event => events.push(event),
    onInsight: insight => insights.push(insight),
  })
  return { runtime, taskManager, inputAssets, events, insights }
}

test('freezes recent frames into a background task and delivers a VisualInsight', async () => {
  let submitted
  const deliveries = []
  const state = fixture({
    backend: {
      run: async input => {
        submitted = input
        return {
          content: JSON.stringify({
            summary: '画面中的物体从左侧移动到右侧。',
            changes: ['位置发生变化'],
            evidenceSequences: [11, 12],
            confidence: 0.91,
          }),
        }
      },
    },
    deliveryRuntime: {
      deliver: async delivery => {
        deliveries.push(delivery)
        return { completed: true }
      },
    },
  })

  const request = await state.runtime.analyze({
    query: '分析最近发生了什么',
    window: 'recent',
    delivery: 'respond',
    turnId: 'turn_1',
  })
  assert.match(request.analysisId, /^vision_/)
  assert.equal(request.observationId, 'observation_1')
  assert.equal(request.fromSequence, 11)
  assert.equal(request.toSequence, 12)
  assert.equal(request.state, 'queued')

  await state.taskManager.wait(request.taskId)
  assert.equal(state.taskManager.get(request.taskId).notificationStatus, 'none')
  assert.equal(submitted.inputParts.length, 2)
  assert.equal(submitted.inputParts[0].mime, 'image/jpeg')
  assert.equal(submitted.inputParts[0].source.type, 'camera')
  assert.match(submitted.inputParts[0].url, /^data:image\/jpeg;base64,/)
  assert.equal(state.insights.length, 1)
  assert.equal(state.insights[0].summary, '画面中的物体从左侧移动到右侧。')
  assert.deepEqual(state.insights[0].evidenceSequences, [11, 12])
  assert.deepEqual(
    state.events.map(event => event.state),
    ['queued', 'running', 'completed'],
  )
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].mode, 'respond')
  assert.match(deliveries[0].text, /<visual_observation>/)
  assert.equal(state.inputAssets.metadataForParts(submitted.inputParts).length, 2)
})

test('latest mode selects one frame and display mode skips AgentDelivery', async () => {
  const state = fixture()
  const request = await state.runtime.analyze({
    query: '看看最新画面',
    window: 'latest',
    delivery: 'display',
  })
  await state.taskManager.wait(request.taskId)
  assert.equal(state.insights.length, 1)
  assert.equal(state.insights[0].fromSequence, 12)
  assert.equal(state.insights[0].toSequence, 12)
})

test('fails explicitly when there are no frames or the backend rejects image input', async () => {
  const noFrames = fixture()
  noFrames.runtime.getFrames = () => []
  await assert.rejects(
    noFrames.runtime.analyze({ query: '分析画面' }),
    error => error.code === 'no_observation_frames',
  )

  const taskManager = new TaskManager()
  const unsupported = new BackgroundVisionRuntime({
    taskManager,
    backendRuntime: {
      describe: () => ({ capabilities: { inputModes: ['text'] } }),
      run: async () => ({ content: '不应执行' }),
      cancel: async () => ({}),
    },
    ownerId: 'owner',
    sessionId: 'session',
    getFrames: () => [{ image: FRAME, sequence: 1, capturedAt: 1 }],
  })
  await assert.rejects(
    unsupported.analyze({ query: '分析画面' }),
    error => error.code === 'backend_image_unsupported',
  )
})
