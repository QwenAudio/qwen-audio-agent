import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutputSelector } from '../presentation/output-selector.mjs'
import { AudioRoute, SelectorState } from '../presentation/contracts.mjs'

function delta(bytes) {
  return Buffer.alloc(bytes, 7).toString('base64')
}

test('buffers and diverts audio while buffering', () => {
  const selector = createOutputSelector({ responseId: 'r1', firstMediaTimeoutMs: 0 })
  assert.equal(selector.state, SelectorState.BUFFERING)
  const first = selector.routeAudio(delta(480), 480)
  assert.equal(first.route, AudioRoute.DIVERT)
  assert.equal(first.flush, null)
  assert.equal(selector.bufferedBytes, 480)
  selector.close()
})

test('commitAvatar is exclusive and clears the buffer without flushing', () => {
  const selector = createOutputSelector({ responseId: 'r1', firstMediaTimeoutMs: 0 })
  selector.routeAudio(delta(480), 480)
  assert.equal(selector.commitAvatar(), true)
  assert.equal(selector.state, SelectorState.COMMITTED_AVATAR)
  assert.equal(selector.bufferedBytes, 0)
  // A late fallback election can never displace a published avatar commit.
  assert.deepEqual(selector.commitAudio('provider_failure'), { committed: false, flush: [] })
  // Subsequent deltas keep flowing to the provider.
  assert.equal(selector.routeAudio(delta(480), 480).route, AudioRoute.DIVERT)
  selector.close()
})

test('commitAudio returns the buffer in order and passes later deltas', () => {
  const selector = createOutputSelector({ responseId: 'r1', firstMediaTimeoutMs: 0 })
  const a = delta(480)
  const b = delta(960)
  selector.routeAudio(a, 480)
  selector.routeAudio(b, 960)
  const result = selector.commitAudio('provider_failure')
  assert.equal(result.committed, true)
  assert.deepEqual(result.flush, [a, b])
  assert.equal(selector.state, SelectorState.COMMITTED_AUDIO)
  assert.equal(selector.routeAudio(delta(480), 480).route, AudioRoute.PASS)
  // A late provider first frame is rejected after fallback committed.
  assert.equal(selector.commitAvatar(), false)
  selector.close()
})

test('buffer overflow forces an audio commit with the flush inline', () => {
  let fallback = null
  const selector = createOutputSelector({
    responseId: 'r1',
    firstMediaTimeoutMs: 0,
    maxBufferedAudioBytes: 1000,
    onFallback: info => { fallback = info },
  })
  selector.routeAudio(delta(480), 480)
  const decision = selector.routeAudio(delta(960), 960)
  assert.equal(decision.route, AudioRoute.PASS)
  assert.equal(decision.flush.length, 1)
  assert.equal(selector.state, SelectorState.COMMITTED_AUDIO)
  assert.equal(fallback.reason, 'buffer_overflow')
  assert.equal(fallback.responseId, 'r1')
  selector.close()
})

test('first media timeout falls back with the buffered flush', async () => {
  let fallback = null
  const selector = createOutputSelector({
    responseId: 'r1',
    firstMediaTimeoutMs: 30,
    onFallback: info => { fallback = info },
  })
  const a = delta(480)
  selector.routeAudio(a, 480)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(selector.state, SelectorState.COMMITTED_AUDIO)
  assert.equal(fallback.code, 'first_media_timeout')
  assert.deepEqual(fallback.flush, [a])
  // The timer must not fire twice.
  const before = fallback
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fallback, before)
  selector.close()
})

test('commit before timeout disarms the fallback', async () => {
  let fallback = null
  const selector = createOutputSelector({
    responseId: 'r1',
    firstMediaTimeoutMs: 40,
    onFallback: () => { fallback = 'fired' },
  })
  selector.routeAudio(delta(480), 480)
  assert.equal(selector.commitAvatar(), true)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(fallback, null)
  assert.equal(selector.state, SelectorState.COMMITTED_AVATAR)
  selector.close()
})

test('draining and terminal transitions', () => {
  const selector = createOutputSelector({ responseId: 'r1', firstMediaTimeoutMs: 0 })
  selector.commitAvatar()
  assert.equal(selector.markDraining(), true)
  assert.equal(selector.state, SelectorState.DRAINING)
  assert.equal(selector.markDraining(), false)
  assert.equal(selector.markTerminal(), true)
  assert.equal(selector.state, SelectorState.TERMINAL)
  assert.equal(selector.markTerminal(), false)
  // Terminal is final.
  assert.equal(selector.cancel('user_interruption'), false)
  selector.close()
})

test('cancel works from every non-terminal state and is final', () => {
  for (const setup of [
    () => {},
    s => s.commitAvatar(),
    s => s.commitAudio(),
    s => { s.commitAvatar(); s.markDraining() },
  ]) {
    const selector = createOutputSelector({ responseId: 'r1', firstMediaTimeoutMs: 0 })
    setup(selector)
    assert.equal(selector.cancel('user_interruption'), true)
    assert.equal(selector.state, SelectorState.CANCELLED)
    assert.equal(selector.cancel('user_interruption'), false)
    assert.equal(selector.commitAvatar(), false)
    selector.close()
  }
})

test('requires a responseId', () => {
  assert.throws(() => createOutputSelector({}), /responseId/)
})
