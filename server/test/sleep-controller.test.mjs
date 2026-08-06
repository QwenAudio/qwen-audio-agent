import assert from 'node:assert/strict'
import test from 'node:test'
import { SleepController } from '../src/voice/sleep-controller.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('sleeps only after the configured idle interval', async () => {
  let sleeps = 0
  const controller = new SleepController({
    timeoutMs: 200,
    onSleep: () => { sleeps += 1 },
  })
  controller.enable()
  // CI runner 计时抖动大，窗口留宽避免定时器提前触发
  await wait(60)
  controller.recordActivity()
  await wait(80)
  assert.equal(sleeps, 0)
  await wait(250)
  assert.equal(sleeps, 1)
  assert.equal(controller.sleeping, true)
  controller.close()
})

test('defers sleep while foreground activity is blocking it', async () => {
  let blocked = true
  let sleeps = 0
  const controller = new SleepController({
    timeoutMs: 100,
    retryMs: 50,
    canSleep: () => !blocked,
    onSleep: () => { sleeps += 1 },
  })
  controller.enable()
  await wait(60)
  assert.equal(sleeps, 0)
  blocked = false
  await wait(250)
  assert.equal(sleeps, 1)
  controller.close()
})

test('can return to a sleeping state when realtime reconnection fails', () => {
  const controller = new SleepController({ timeoutMs: 100 })
  controller.enable()
  controller.holdSleeping()
  assert.equal(controller.wake(), true)
  assert.equal(controller.sleeping, false)
  assert.equal(controller.holdSleeping(), true)
  assert.equal(controller.sleeping, true)
  controller.close()
})

test('enables without auto-sleeping when timeoutMs is 0', async () => {
  let sleeps = 0
  const controller = new SleepController({
    timeoutMs: 0,
    onSleep: () => { sleeps += 1 },
  })
  assert.equal(controller.enable(), true)
  await wait(15)
  assert.equal(sleeps, 0)
  controller.close()
})
