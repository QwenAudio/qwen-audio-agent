import assert from 'node:assert/strict'
import test from 'node:test'
import { createGracefulShutdown } from '../src/graceful-shutdown.mjs'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

test('waits for desktop cleanup before allowing the app to quit', async () => {
  const cleanup = deferred()
  let quitCalls = 0
  let prevented = 0
  const shutdown = createGracefulShutdown({
    app: { quit: () => { quitCalls += 1 } },
    cleanup: () => cleanup.promise,
  })

  shutdown({ preventDefault: () => { prevented += 1 } })
  shutdown({ preventDefault: () => { prevented += 1 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(prevented, 2)
  assert.equal(quitCalls, 0)

  cleanup.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quitCalls, 1)

  // Electron emits before-quit again for the final app.quit().
  shutdown({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 2)
})

test('still quits when cleanup fails and reports the failure', async () => {
  const failures = []
  let quitCalls = 0
  const shutdown = createGracefulShutdown({
    app: { quit: () => { quitCalls += 1 } },
    cleanup: async () => { throw new Error('cleanup failed') },
    onError: error => failures.push(error.message),
  })

  shutdown({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(failures, ['cleanup failed'])
  assert.equal(quitCalls, 1)
})
