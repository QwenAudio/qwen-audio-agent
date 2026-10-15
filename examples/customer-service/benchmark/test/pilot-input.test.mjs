import test from 'node:test'
import assert from 'node:assert/strict'
import { countPilotModel, forwardPilotReply } from '../pilot-input.mjs'

test('pilot model instrumentation retains backend authorization interpretation and counts it', async () => {
  const calls = []
  const result = { authorized: false, response: 'revise', reason: 'changed destination' }
  const model = {
    async complete(options) { calls.push(['complete', this, options]); return { content: 'preview' } },
    async authorizePriorPlan(options) { calls.push(['authorize', this, options]); return result },
  }
  const counts = { modelCalls: 0, approvalClassifications: 0 }
  const counted = countPilotModel(model, counts)
  const input = { messages: [] }
  const evidence = { evidence: { customerReply: 'Use the other card.' } }
  assert.deepEqual(await counted.complete(input), { content: 'preview' })
  assert.equal(await counted.authorizePriorPlan(evidence), result)
  assert.deepEqual(calls, [['complete', model, input], ['authorize', model, evidence]])
  assert.deepEqual(counts, { modelCalls: 1, approvalClassifications: 1 })
})

for (const content of ['Yes, go ahead.', 'No, do not refund it.', 'Use the other card.', 'How much is the fee?']) {
  test(`pilot forwards natural reply unchanged without an action: ${content}`, async () => {
    const calls = []
    const backend = {
      async respondInput(...args) { calls.push(args) },
      async cancel() { assert.fail('a natural reply must not cancel the task') },
    }
    const options = { ownerId: 'tau-pilot' }
    assert.equal(await forwardPilotReply(backend, {
      taskId: 'original-task', input: { id: 'original-preview' },
    }, { content, stop: false }, options), true)
    assert.deepEqual(calls, [['original-task', 'original-preview', { text: content }, options]])
  })
}

test('pilot user stop cancels the actual task without answering the pending preview', async () => {
  const calls = []
  const backend = {
    async cancel(...args) { calls.push(args) },
    async respondInput() { assert.fail('user stop must not become a preview decision') },
  }
  const options = { ownerId: 'tau-pilot' }
  assert.equal(await forwardPilotReply(backend, {
    taskId: 'original-task', input: { id: 'original-preview' },
  }, { content: 'Stop.', stop: true }, options), false)
  assert.deepEqual(calls, [['original-task', options]])
})
