import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dictationControlView,
  requiresKeyboardFallback,
} from '../src/dictation-view.js'

test('hides disabled dictation and exposes a labelled action for every visible state', () => {
  assert.deepEqual(dictationControlView({ enabled: false, state: 'listening' }), {
    visible: false,
    action: 'none',
    label: '',
  })
  const cases = [
    ['idle', 'start', '听写已关闭'],
    ['starting', 'pause', '正在启动听写'],
    ['listening', 'pause', '听写中'],
    ['transcribing', 'pause', '正在转写'],
    ['editing', 'pause', '正在编辑草稿'],
    ['ready-to-send', 'pause', '准备发送'],
    ['paused', 'resume', '听写已暂停'],
    ['stopped', 'start', '听写已停止'],
    ['cancelled', 'start', '听写已取消'],
    ['error', 'start', '听写不可用，请使用键盘输入'],
  ]
  for (const [state, action, label] of cases) {
    assert.deepEqual(dictationControlView({ enabled: true, state }), {
      visible: true,
      action,
      label,
    })
  }
})

test('provider errors require keyboard fallback instead of primary Realtime', () => {
  assert.equal(requiresKeyboardFallback({ type: 'dictation.error' }), true)
  assert.equal(requiresKeyboardFallback({ type: 'dictation.error' }, false), false)
  assert.equal(requiresKeyboardFallback({ type: 'error' }), false)
})
