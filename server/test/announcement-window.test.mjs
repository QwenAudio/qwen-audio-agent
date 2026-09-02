import assert from 'node:assert/strict'
import test from 'node:test'
import { AnnouncementManager } from '../src/voice/announcement/announcement-manager.mjs'
import { AnnouncementWindow } from '../src/voice/announcement/announcement-window.mjs'

test('blocks announcements throughout thinking and foreground playback', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-1')
  assert.equal(window.isBlocked(), true)

  window.endSpeech()
  assert.equal(window.isBlocked(), true)

  window.queueAudio('response-1', { turnId: 'turn-1', origin: 'model' })
  window.responseDone({ turnId: 'turn-1', origin: 'model', hasAudio: true })
  assert.equal(window.isBlocked(), true)

  window.startPlayback('response-1')
  assert.equal(window.isPlaying(), true)
  window.finishPlayback('response-1')
  assert.equal(window.isBlocked(), false)
})

test('keeps the insertion window closed across an intermediate tool call response', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-tool')
  window.endSpeech()
  window.responseDone({
    turnId: 'turn-tool',
    origin: 'model',
    awaitsToolFollowUp: true,
  })
  assert.equal(window.isBlocked(), true)

  window.queueAudio('response-tool-result', {
    turnId: 'turn-tool',
    origin: 'agent',
  })
  window.finishPlayback('response-tool-result')
  assert.equal(window.isBlocked(), false)
})

test('releases a spoken tool acknowledgement when its follow-up is suppressed', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-tool')
  window.endSpeech()
  window.queueAudio('response-tool-ack', {
    turnId: 'turn-tool',
    origin: 'model',
  })
  window.responseDone({
    turnId: 'turn-tool',
    origin: 'model',
    hasAudio: true,
    awaitsToolFollowUp: false,
  })

  window.finishPlayback('response-tool-ack', { awaitsToolFollowUp: false })
  assert.equal(window.isBlocked(), false)
})

test('releases a suppressed tool follow-up when playback ended before response.done', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-tool')
  window.endSpeech()
  window.queueAudio('response-tool-ack', {
    turnId: 'turn-tool',
    origin: 'model',
  })
  window.finishPlayback('response-tool-ack', { awaitsToolFollowUp: true })
  assert.equal(window.isBlocked(), true)

  window.responseDone({
    turnId: 'turn-tool',
    origin: 'model',
    hasAudio: false,
    awaitsToolFollowUp: false,
  })
  assert.equal(window.isBlocked(), false)
})

test('releases a tool-call turn when its agent follow-up completes without audio', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-tool')
  window.endSpeech()
  window.responseDone({
    turnId: 'turn-tool',
    origin: 'model',
    awaitsToolFollowUp: true,
  })
  assert.equal(window.isBlocked(), true)

  window.responseDone({
    turnId: 'turn-tool',
    origin: 'agent',
  })
  assert.equal(window.isBlocked(), false)
})

test('an announcement response never completes the active user turn', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-user')
  window.endSpeech()
  window.responseDone({
    turnId: 'turn-background',
    origin: 'announcement',
    hasAudio: false,
  })
  assert.equal(window.isBlocked(), true)
})

test('releases a tool-call turn when its follow-up response fails before audio', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-failed')
  window.endSpeech()
  window.responseDone({
    turnId: 'turn-failed',
    origin: 'model',
    awaitsToolFollowUp: true,
    failed: true,
  })
  assert.equal(window.isBlocked(), false)
})

test('a new user turn stays authoritative when older playback is cancelled', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-old')
  window.endSpeech()
  window.queueAudio('response-old', { turnId: 'turn-old', origin: 'model' })

  window.beginTurn('turn-new')
  window.finishPlayback('response-old')
  assert.equal(window.isBlocked(), true)

  window.endSpeech()
  window.responseDone({ turnId: 'turn-new', origin: 'model' })
  assert.equal(window.isBlocked(), false)
})

test('explicit interruption releases the turn but queued audio remains a blocker until cancelled', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-1')
  window.endSpeech()
  window.queueAudio('response-1', { turnId: 'turn-1', origin: 'model' })
  window.interrupt()
  assert.equal(window.isBlocked(), true)
  window.finishPlayback('response-1')
  assert.equal(window.isBlocked(), false)
})

test('late or duplicate playback receipts are harmless', () => {
  const window = new AnnouncementWindow()
  window.beginTurn('turn-1')
  window.endSpeech()

  assert.doesNotThrow(() => window.finishPlayback('missing'))
  assert.equal(window.isBlocked(), true)

  window.queueAudio('response-1', {
    turnId: 'turn-1',
    origin: 'model',
  })
  window.finishPlayback('response-1')
  assert.equal(window.isBlocked(), false)

  assert.doesNotThrow(() => window.finishPlayback('response-1'))
  assert.equal(window.isBlocked(), false)
})

test('delivers a queued result only after the complete foreground voice lifecycle', async () => {
  const window = new AnnouncementWindow()
  const delivered = []
  const manager = new AnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async text => {
        delivered.push(text)
        return { completed: true, contextInjected: true }
      },
    }),
    isDeliveryBlocked: () => window.isBlocked(),
    announceIntoContext: true,
    batchWindowMs: 0,
  })

  window.beginTurn('turn-foreground')
  window.endSpeech()
  manager.completed({ id: 'job-1', result: '后台结果' })
  await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(delivered.length, 0)

  window.queueAudio('response-foreground', {
    turnId: 'turn-foreground',
    origin: 'model',
  })
  window.responseDone({
    turnId: 'turn-foreground',
    origin: 'model',
    hasAudio: true,
  })
  manager.flush()
  await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(delivered.length, 0)

  window.finishPlayback('response-foreground')
  manager.flush()
  await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(delivered.length, 1)
  manager.close()
})
