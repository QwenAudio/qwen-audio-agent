import assert from 'node:assert/strict'
import test from 'node:test'
import { createTransientNotice } from '../client/src/notice.mjs'

test('notice expires, ignores duplicate callbacks, and can be dismissed', () => {
  const rendered = []
  const timers = new Map()
  let nextId = 0
  const notice = createTransientNotice(value => rendered.push(value), {
    durationMs: 6000,
    schedule: callback => { const id = ++nextId; timers.set(id, callback); return id },
    cancel: id => timers.delete(id),
  })

  notice('连接中断')
  assert.deepEqual(rendered, ['连接中断'])
  notice('连接中断')
  assert.equal(nextId, 1)
  timers.get(1)()
  assert.deepEqual(rendered, ['连接中断', ''])

  notice('播放失败')
  assert.equal(timers.has(2), true)
  notice()
  assert.equal(timers.has(2), false)
  assert.deepEqual(rendered, ['连接中断', '', '播放失败', ''])

  notice('首条')
  notice('第二条')
  assert.equal(timers.has(3), false)
  assert.equal(timers.has(4), true)
  assert.equal(rendered.at(-1), '第二条')
})
