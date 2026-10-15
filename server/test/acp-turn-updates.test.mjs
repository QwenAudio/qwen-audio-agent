import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpTurnUpdates } from '../src/backend/adapters/acp/turn-updates.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(mode = 'restart', extra = {}) {
  const calls = []
  const client = {
    calls,
    cancels: [],
    steeringMode: () => mode,
    prompt(sessionId, prompt, options) {
      const pending = Promise.withResolvers()
      calls.push({ sessionId, prompt, options, ...pending })
      return pending.promise
    },
    async cancelSession(sessionId) { this.cancels.push(sessionId) },
    ...extra,
  }
  const updates = new AcpTurnUpdates({ client, sessionId: 'session-A', cancelTimeoutMs: 20 })
  return { client, updates, calls }
}

test('cancel/restart waits for the old prompt response, keeps Session and hides the superseded result', async () => {
  const { client, updates, calls } = harness()
  const done = updates.run('original')
  const receipt = updates.enqueue('new requirement')
  await tick()
  assert.deepEqual(client.cancels, ['session-A'])
  assert.equal(calls.length, 1)
  calls[0].resolve({ content: 'obsolete', response: { stopReason: 'cancelled' } })
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].sessionId, calls[0].sessionId)
  assert.match(JSON.stringify(calls[1].prompt), /new requirement/u)
  assert.doesNotMatch(JSON.stringify(calls[1].prompt), /original/u)
  calls[1].options.onUpdate({ sessionUpdate: 'agent_message_chunk' })
  assert.deepEqual(await receipt.completion, { status: 'delivered' })
  calls[1].resolve({ content: 'updated' })
  assert.deepEqual(await done, { content: 'updated' })
})

test('native injected steering neither cancels nor opens another prompt', async () => {
  const steering = []
  const { client, updates, calls } = harness('extension', {
    async steerSession(...args) { steering.push(args); return { outcome: 'injected' } },
  })
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  await receipt.completion
  assert.equal(steering[0][0], 'session-A')
  assert.equal(calls.length, 1)
  assert.equal(client.cancels.length, 0)
  calls[0].resolve({ content: 'updated natively' })
  assert.equal((await done).content, 'updated natively')
})

test('native promptRequired race resumes once after the prior prompt settles', async () => {
  const { client, updates, calls } = harness('extension', {
    async steerSession() {
      calls[0].resolve({ content: 'old result' })
      return { outcome: 'promptRequired' }
    },
  })
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(client.cancels.length, 0)
  calls[1].resolve({ content: 'new result' })
  await receipt.completion
  assert.equal((await done).content, 'new result')
})

test('failed followup initialization does not falsely acknowledge delivery', async () => {
  const { updates, calls, client } = harness()
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  client.cancelSession = async () => calls[0].resolve({ content: 'cancelled' })
  await tick()
  calls[1].reject(new Error('followup rejected'))
  await assert.rejects(receipt.completion, /followup rejected/u)
  await assert.rejects(done, /followup rejected/u)
})

test('Agent pull drains ordered content only at the Agent loop boundary', async () => {
  const { client, updates, calls } = harness('pull')
  const done = updates.run('original')
  const a = updates.enqueue('first')
  const b = updates.enqueue('second')
  await tick()
  assert.equal(client.cancels.length, 0)
  assert.deepEqual(calls[0].options.onMidTurnDrain(), {
    items: [
      { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
    ], hasQueuedPrompt: false,
  })
  await Promise.all([a.completion, b.completion])
  assert.deepEqual(updates.drain(), { items: [], hasQueuedPrompt: false })
  calls[0].resolve({ content: 'updated' })
  await done
})

test('a failed pull batch preparation rejects every receipt without acknowledging delivery', async () => {
  let acknowledgements = 0
  const updates = new AcpTurnUpdates({
    client: {}, sessionId: 'session-A',
    preparePrompt() {
      throw new Error('cannot prepare context')
    },
  })
  const receipts = [updates.enqueue('first'), updates.enqueue('second')]
  receipts.forEach(receipt => receipt.completion.then(() => { acknowledgements += 1 }, () => {}))
  assert.throws(() => updates.drain(), /cannot prepare context/)
  for (const receipt of receipts) await assert.rejects(receipt.completion, /cannot prepare context/)
  assert.equal(acknowledgements, 0)
  assert.deepEqual(updates.drain(), { items: [], hasQueuedPrompt: false })
})

test('updates received before startup are included without cancelling the first prompt', async () => {
  const { client, updates, calls } = harness()
  const receipt = updates.enqueue('new requirement')
  const done = updates.run('original')
  calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk' })
  await receipt.completion
  assert.match(JSON.stringify(calls[0].prompt), /original.*new requirement/u)
  assert.equal(client.cancels.length, 0)
  calls[0].resolve({ content: 'done' })
  await done
})

test('an undrained pull is sent after prompt completion, not lost at the final boundary', async () => {
  const { updates, calls, client } = harness('pull')
  const done = updates.run('original')
  const receipt = updates.enqueue('late update')
  await tick()
  calls[0].resolve({ content: 'old result' })
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(client.cancels.length, 0)
  calls[1].resolve({ content: 'new result' })
  await receipt.completion
  assert.equal((await done).content, 'new result')
})

test('multiple updates during cancellation are coalesced in order', async () => {
  const { updates, calls, client } = harness()
  const done = updates.run('original')
  const a = updates.enqueue('first')
  await tick()
  const b = updates.enqueue('second')
  calls[0].resolve({ content: 'cancelled' })
  await tick()
  assert.equal(client.cancels.length, 1)
  assert.match(JSON.stringify(calls[1].prompt), /first.*second/u)
  calls[1].resolve({ content: 'done' })
  await Promise.all([a.completion, b.completion])
  await done
})

test('cancel timeout never starts a concurrent prompt and marks the context uncertain', async () => {
  const { updates, calls } = harness()
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  await assert.rejects(done, error => error.code === 'update_unconfirmed' && error.contextUncertain)
  await assert.rejects(receipt.completion)
  assert.equal(calls.length, 1)
  calls[0].resolve({ content: 'late result' })
})

test('ambiguous native outcome is not replayed through the fallback', async () => {
  const { updates, calls } = harness('extension', {
    async steerSession() { return { outcome: 'startedNewTurn' } },
    async cancelSession() { calls[0].resolve({ content: 'cancelled' }) },
  })
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  await assert.rejects(done, error => error.code === 'update_unconfirmed' && error.updateDeliveryFailed)
  await assert.rejects(receipt.completion)
  assert.equal(calls.length, 1)
})

test('user cancellation does not turn pending updates into another prompt', async () => {
  const controller = new AbortController()
  const { updates, calls } = harness('pull')
  updates.signal = controller.signal
  const done = updates.run('original')
  const receipt = updates.enqueue('adjust')
  await tick()
  controller.abort(new Error('user cancelled'))
  calls[0].resolve({ content: 'cancelled' })
  await assert.rejects(done, /user cancelled/u)
  await assert.rejects(receipt.completion)
  assert.equal(calls.length, 1)
})
