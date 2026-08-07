import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.localStorage = {
  getItem: key => (key === 'qwen-audio-lang' ? 'zh-CN' : null),
}
import { resultLabel } from '../src/presentation.js'

test('uses the backend presentation title for a result card', () => {
  assert.equal(resultLabel({ title: '杭州天气' }), '杭州天气')
})

test('uses a clear fallback instead of implying screen capture', () => {
  assert.equal(resultLabel({ title: '  ' }), '执行结果')
  assert.equal(resultLabel({}), '执行结果')
})
