import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeRecoveryContext } from '../src/voice/realtime-recovery-context.mjs'

test('restores prior conversation while excluding only the rejected turn', () => {
  const recovery = new RealtimeRecoveryContext()
  const messages = [
    { id: 'u1', role: 'user', turnId: 'turn-1', content: '正常问题' },
    { id: 'a1', role: 'assistant', turnId: 'turn-1', content: '正常回答' },
    { id: 'u2', role: 'user', turnId: 'turn-2', content: '被拒绝的问题' },
    { id: 'a2', role: 'assistant', turnId: 'turn-2', content: '残缺回答' },
    { id: 'u3', role: 'user', turnId: 'turn-3', content: '恢复后的问题' },
  ]

  recovery.excludeFailure({ turnId: 'turn-2' }, messages)

  assert.deepEqual(
    recovery.project(messages).map(message => message.id),
    ['u1', 'a1', 'u3'],
  )
})

test('quarantines an uncorrelated snapshot without deleting history or excluding new turns', () => {
  const recovery = new RealtimeRecoveryContext()
  const messages = [
    { id: 'u1', role: 'user', content: '正常问题' },
    { id: 'a1', role: 'assistant', content: '正常回答' },
    { id: 'u2', role: 'user', content: '被拒绝的问题' },
  ]

  recovery.excludeFailure({}, messages)

  assert.deepEqual(
    recovery.project(messages).map(message => message.id),
    [],
  )
  assert.equal(messages.length, 3)
  assert.deepEqual(recovery.project([...messages, { id: 'u3', role: 'user' }]), [
    { id: 'u3', role: 'user' },
  ])
})

test('bounds recovery and only a successful user turn resets its budget', () => {
  const recovery = new RealtimeRecoveryContext()
  const messages = [
    { id: 'u1', turnId: 'turn-1' },
    { id: 'u2', turnId: 'turn-2' },
  ]
  assert.equal(recovery.beginRecovery({ turnId: 'turn-2' }, messages), true)
  assert.deepEqual(recovery.project(messages).map(m => m.id), ['u1'])
  assert.equal(recovery.beginRecovery({ turnId: 'turn-2' }, messages), true)
  assert.deepEqual(recovery.project(messages), [])
  assert.equal(recovery.beginRecovery({}, messages), false)
  recovery.recordSuccessfulTurn()
  assert.equal(recovery.beginRecovery({ turnId: 'turn-3' }, messages), true)
})

test('excludes a rejected task presentation without removing adjacent dialogue', () => {
  const recovery = new RealtimeRecoveryContext()
  const messages = [
    { id: 'u1', role: 'user', turnId: 'turn-1', content: '正常问题' },
    { id: 'task', role: 'assistant', taskId: 'task-1', content: '被拒绝的任务结果' },
    { id: 'a1', role: 'assistant', turnId: 'turn-1', content: '正常回答' },
  ]

  recovery.excludeFailure({ taskId: 'task-1' }, messages)

  assert.deepEqual(
    recovery.project(messages).map(message => message.id),
    ['u1', 'a1'],
  )
})
