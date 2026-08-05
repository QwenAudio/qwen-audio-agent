import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTION_PROMISE_MAX_CHARS,
  promisesAction,
  shouldCorrectActionPromise,
} from '../src/voice/action-promise.mjs'

test('a short spoken promise to act is recognised', () => {
  assert.equal(promisesAction('我来查一下杭州今天的天气。'), true)
  assert.equal(promisesAction('好的，我先帮你把这个仓库拉下来。'), true)
  assert.equal(promisesAction('马上去看这个文件。'), true)
  assert.equal(promisesAction('稍等，正在处理。'), true)
})

test('a statement without an action claim is not a promise', () => {
  assert.equal(promisesAction('杭州今天二十六度，多云。'), false)
  assert.equal(promisesAction('我觉得这两个方案差别不大。'), false)
  assert.equal(promisesAction(''), false)
})

test('a request for confirmation is not a promise', () => {
  // Correcting a question would push the frontend to execute work the user has
  // not agreed to yet.
  assert.equal(promisesAction('我来帮你重构这个模块，可以吗？'), false)
  assert.equal(promisesAction('需要我现在就去改吗'), false)
  assert.equal(promisesAction('我先跑一遍测试，好吗'), false)
})

test('a turn already delivering substance is not treated as a bare promise', () => {
  const delivered = `我来给你念一下：${'排序结果依次是甲乙丙丁'.repeat(6)}`
  assert.ok(delivered.length > ACTION_PROMISE_MAX_CHARS)
  assert.equal(promisesAction(delivered), false)
})

test('standing down is not a promise even with the same opening', () => {
  // "我先退下了" opens exactly like "我先查一下" but ends the exchange. Treating
  // it as unmet work would push the front end to spawn a task nobody asked for.
  assert.equal(promisesAction('好的，我先退下了。'), false)
  assert.equal(promisesAction('我先不打扰你了。'), false)
  assert.equal(promisesAction('那我先休息一下。'), false)
  assert.equal(promisesAction('好的，拜拜。'), false)
  assert.equal(promisesAction('有事再叫我。'), false)
  assert.equal(promisesAction('我先待命，需要时喊我。'), false)

  // The same opening still counts when actual work follows.
  assert.equal(promisesAction('我先去查一下这个报错。'), true)
})

test('a promise without a tool call is corrected once per turn', () => {
  const promise = {
    origin: 'model',
    hasFunctionCall: false,
    transcript: '我来查一下这个报错的原因。',
  }

  assert.equal(shouldCorrectActionPromise(promise), true)
  assert.equal(
    shouldCorrectActionPromise({ ...promise, alreadyCorrected: true }),
    false,
  )
})

test('a kept promise is never corrected', () => {
  assert.equal(shouldCorrectActionPromise({
    origin: 'model',
    hasFunctionCall: true,
    transcript: '我来查一下这个报错的原因。',
  }), false)
})

test('an interrupted, failed or announced turn proves nothing about routing', () => {
  const transcript = '我来查一下这个报错的原因。'

  assert.equal(
    shouldCorrectActionPromise({ transcript, failed: true }),
    false,
  )
  assert.equal(
    shouldCorrectActionPromise({ transcript, suppressed: true }),
    false,
  )
  assert.equal(
    shouldCorrectActionPromise({ transcript, origin: 'announcement' }),
    false,
  )
})
