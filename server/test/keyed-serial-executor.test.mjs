import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedSerialExecutor } from '../src/agent/keyed-serial-executor.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('runs higher-priority work before ordinary queued work', async () => {
  const executor = new KeyedSerialExecutor()
  const gate = deferred()
  const order = []
  const first = executor.run('owner', async () => {
    order.push('running')
    await gate.promise
  })
  const ordinary = executor.run('owner', async () => order.push('ordinary'))
  const quick = executor.run('owner', async () => order.push('quick'), {
    priority: 10,
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['running'])
  gate.resolve()
  await Promise.all([first, ordinary, quick])
  assert.deepEqual(order, ['running', 'quick', 'ordinary'])
})

test('drops an aborted queued operation without blocking the key', async () => {
  const executor = new KeyedSerialExecutor()
  const gate = deferred()
  const controller = new AbortController()
  const order = []
  const first = executor.run('owner', async () => {
    await gate.promise
  })
  const skipped = executor.run('owner', async () => order.push('skipped'), {
    priority: 10,
    signal: controller.signal,
  })
  const next = executor.run('owner', async () => order.push('next'))

  controller.abort(new Error('cancelled'))
  await assert.rejects(skipped, /cancelled/)
  gate.resolve()
  await Promise.all([first, next])
  assert.deepEqual(order, ['next'])
})
