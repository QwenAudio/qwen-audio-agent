import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DashScopeVisualReader } from '../vision/dashscope-reader.mjs'
import { validateFrame } from '../vision/frame.mjs'
import { VisualObservers } from '../vision/observers.mjs'
import { createVisionTools } from '../vision/tools.mjs'

const frame = () => ({ source: 'camera', generation: 'source-1', capturedAt: Date.now(), image: '/9j/2Q==' })
function context() {
  return { ownerId: 'user', sessionId: 'session', signal: new AbortController().signal,
    supportsClientAction: () => true, isCurrent: () => true,
    requestClientAction: async () => ({ output: frame() }),
    registerInputs: () => [{ ref: 'input_1' }], deliver: async () => ({ completed: true }) }
}
class Socket extends EventEmitter {
  readyState = 1
  sent = []
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  event(value) { this.emit('message', JSON.stringify(value)) }
}
function readerFixture(options = {}) {
  const sockets = []
  const reader = new DashScopeVisualReader({ apiKey: 'test-only', timeoutMs: 200, ...options,
    connect: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  return { reader, sockets }
}
function complete(socket, text) {
  socket.emit('open')
  socket.event({ type: 'session.updated' })
  socket.event({ type: 'session.updated' })
  socket.event({ type: 'input_audio_buffer.committed' })
  socket.event({ type: 'response.text.delta', delta: text })
  socket.event({ type: 'response.done', response: { status: 'completed' } })
}

test('frame validation rejects stale, invalid and oversized media', () => {
  assert.equal(validateFrame(frame()).image, '/9j/2Q==')
  for (const changes of [{ capturedAt: 0 }, { image: 'not-jpeg' }, { source: 'file:///private' },
    { image: 'a'.repeat(300_000) }, { generation: 'a'.repeat(81) }]) {
    assert.throws(() => validateFrame({ ...frame(), ...changes }))
  }
})
test('reader uses its own manual text-only session, audio/image/commit ordering and closes', async () => {
  const { reader, sockets } = readerFixture()
  const result = reader.read(frame(), 'What is visible?')
  complete(sockets[0], 'A red rectangle.')
  assert.equal(await result, 'A red rectangle.')
  assert.deepEqual(sockets[0].sent.map(item => item.type),
    ['session.update', 'input_audio_buffer.append', 'input_image_buffer.append', 'input_audio_buffer.commit', 'response.create'])
  assert.deepEqual(sockets[0].sent[0].session.modalities, ['text'])
  assert.equal(sockets[0].sent[0].session.turn_detection, null)
  assert.equal(sockets[0].readyState, 3)
  assert.equal(reader.active.size, 0)
})
test('reader bounds concurrency, deadline and abort; provider details never escape', async () => {
  const { reader, sockets } = readerFixture({ maxConcurrent: 1, timeoutMs: 20 })
  const controller = new AbortController()
  const first = reader.read(frame(), 'question', { signal: controller.signal })
  await assert.rejects(reader.read(frame(), 'question'), /busy/)
  controller.abort()
  await assert.rejects(first, /cancelled/)
  await assert.rejects(reader.read(frame(), 'question'), /timed out/)
  const third = reader.read(frame(), 'question')
  sockets.at(-1).event({ type: 'error', error: { message: 'secret raw payload' } })
  await assert.rejects(third, error => !error.message.includes('secret') && /rejected/.test(error.message))
  const fourth = reader.read(frame(), 'question')
  reader.close()
  await assert.rejects(fourth, /closed/)
})
test('structured observations require typed JSON and never fabricate a match', async () => {
  for (const text of ['plain answer', '{"match":"true","summary":"yes"}', '{"match":true,"summary":"red"}']) {
    const { reader, sockets } = readerFixture()
    const result = reader.read(frame(), 'Is it red?', { structured: true })
    complete(sockets[0], text)
    if (text.includes('"red"')) assert.deepEqual(await result, { match: true, summary: 'red' })
    else await assert.rejects(result, /Invalid/)
  }
  const { reader, sockets } = readerFixture()
  const fenced = reader.read(frame(), 'condition', { structured: true })
  complete(sockets[0], '```json\n{"match":false,"summary":"not visible"}\n```')
  assert.deepEqual(await fenced, { match: false, summary: 'not visible' })
})

function observerFixture(reader = { read: async () => ({ match: true, summary: 'ready' }) }) {
  let now = 100_000
  const timers = new Map()
  let index = 0
  const observers = new VisualObservers({ reader, capture: async () => frame(),
    now: () => now, setTimer: (fn, delay) => { timers.set(++index, { fn, delay }); return index },
    clearTimer: id => timers.delete(id) })
  return { observers, timers, advance: ms => { now += ms } }
}
test('condition is edge-triggered with cooldown, once by default and bounded lifetime', async () => {
  let match = true
  const { observers, advance, timers } = observerFixture({ read: async () => ({ match, summary: 'ready' }) })
  const ctx = context()
  const deliveries = []
  ctx.deliver = async (value, options) => { deliveries.push({ value, options }); return { completed: true } }
  const once = await observers.start({ focus: 'becomes ready' }, ctx)
  await observers.tick(observers.tasks.get(once.id))
  assert.equal(observers.list(ctx).length, 0)
  assert.equal(deliveries.length, 1)
  const repeating = await observers.start({ focus: 'becomes ready', repeat: true }, ctx)
  const task = observers.tasks.get(repeating.id)
  await observers.tick(task)
  advance(30_000)
  await observers.tick(task)
  assert.equal(deliveries.length, 2, 'continuously true is not a new edge')
  match = false
  await observers.tick(task)
  match = true
  await observers.tick(task)
  assert.equal(deliveries.length, 3)
  const deadline = timers.get(task.expires)
  deadline.fn()
  assert.equal(observers.list(ctx).length, 0)
  assert.equal(deliveries.at(-1).options.shouldDeliver(), false)
})
test('narration deduplicates, blocked delivery retries and disconnect cancels', async () => {
  const { observers, advance } = observerFixture()
  const controller = new AbortController()
  const ctx = { ...context(), signal: controller.signal }
  let deliveries = 0
  ctx.deliver = async () => ({ completed: ++deliveries > 1 })
  const started = await observers.start({ mode: 'narration', focus: 'changes' }, ctx)
  const task = observers.tasks.get(started.id)
  await observers.tick(task)
  await observers.tick(task)
  advance(30_000)
  await observers.tick(task)
  assert.equal(deliveries, 2)
  controller.abort()
  assert.equal(observers.list(ctx).length, 0)
  assert.equal(task.controller.signal.aborted, true)
})
test('cancellation while inference is pending suppresses stale notification', async () => {
  const pending = Promise.withResolvers()
  const { observers } = observerFixture({ read: () => pending.promise })
  const ctx = context()
  let count = 0
  ctx.deliver = async () => { count++; return { completed: true } }
  const started = await observers.start({ focus: 'done' }, ctx)
  const tick = observers.tick(observers.tasks.get(started.id))
  observers.stopSession(ctx)
  pending.resolve({ match: true, summary: 'late answer' })
  await tick
  assert.equal(count, 0)
})
test('observation errors fail closed; caps, ownership and generation are enforced', async () => {
  const { observers } = observerFixture()
  const ctx = context()
  const first = await observers.start({ focus: 'done' }, ctx)
  await observers.start({ focus: 'other' }, ctx)
  await assert.rejects(observers.start({ focus: 'third' }, ctx), /limit/)
  assert.equal(observers.stop(first.id, context()), false)
  observers.capture = async () => ({ ...frame(), generation: 'new' })
  await observers.tick(observers.tasks.get(first.id))
  assert.equal(observers.list(ctx)[0].status, 'failed')
  observers.close()
  assert.equal(observers.tasks.size, 0)
})
test('capture returns only description and usable input references; source change discards late pixels', async () => {
  const pending = Promise.withResolvers()
  const reader = { read: async () => 'A diagram', close() {} }
  const source = createVisionTools({ reader })
  const ctx = context()
  let registered = 0
  ctx.registerInputs = parts => { registered++; assert.equal(parts[0].mime, 'image/jpeg'); return [{ ref: 'input_1' }] }
  const result = await source.execute('capture_visual', { question: 'Describe' }, ctx)
  assert.equal(result.description, 'A diagram')
  assert.deepEqual(result.input_refs, ['input_1'])
  assert.equal(JSON.stringify(result).includes('/9j/'), false)
  reader.read = () => pending.promise
  const late = source.execute('capture_visual', { question: 'Describe' }, ctx)
  source.invalidateSession(ctx)
  pending.resolve('stale')
  assert.equal((await late).status, 'failed')
  assert.equal(registered, 1)
  assert.equal((await source.execute('capture_visual', {}, { ...ctx, supportsClientAction: () => false })).status, 'failed')
  source.close()
})
