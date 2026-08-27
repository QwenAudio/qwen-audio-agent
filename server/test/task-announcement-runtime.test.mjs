import assert from 'node:assert/strict'
import test from 'node:test'
import { AnnouncementManager } from '../src/voice/announcement/announcement-manager.mjs'
import { ProgressAnnouncementManager } from '../src/voice/announcement/progress-announcement-manager.mjs'
import {
  createTaskAnnouncementRuntime,
  resolveTaskAnnouncementRuntime,
} from '../src/voice/announcement/task-announcement-runtime.mjs'

function resultRuntime() {
  return Object.fromEntries([
    'completed',
    'failed',
    'dismissActive',
    'confirmMany',
    'retryMany',
    'flush',
    'pause',
    'close',
  ].map(method => [method, () => {}]))
}

function progressRuntime() {
  return Object.fromEntries([
    'offer',
    'remove',
    'clear',
    'flush',
    'close',
  ].map(method => [method, () => {}]))
}

test('composes the existing announcement managers by default', () => {
  const runtime = createTaskAnnouncementRuntime({
    resultOptions: {
      getFrontend: () => null,
      isDeliveryBlocked: () => true,
    },
    progressOptions: {
      getFrontend: () => null,
      isDeliveryBlocked: () => true,
    },
  })
  assert.equal(runtime.results instanceof AnnouncementManager, true)
  assert.equal(runtime.progress instanceof ProgressAnnouncementManager, true)
  runtime.results.close()
  runtime.progress.close()
})

test('accepts one code-level factory for replacing the whole Task announcement runtime', () => {
  const expected = {
    results: resultRuntime(),
    progress: progressRuntime(),
  }
  const options = { resultOptions: {}, progressOptions: {} }
  let received
  const actual = resolveTaskAnnouncementRuntime(value => {
    received = value
    return expected
  }, options)
  assert.equal(received, options)
  assert.equal(actual, expected)
})

test('rejects incomplete scenario announcement implementations at composition time', () => {
  assert.throws(
    () => resolveTaskAnnouncementRuntime(() => ({
      results: {},
      progress: progressRuntime(),
    }), {}),
    /results\.completed must be a function/u,
  )
  assert.throws(
    () => resolveTaskAnnouncementRuntime(null, {}),
    /taskAnnouncementFactory must be a function/u,
  )
})
