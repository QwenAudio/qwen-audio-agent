import assert from 'node:assert/strict'
import test from 'node:test'
import { visualFeatures } from '../vision/features.mjs'

test('visual support is independent from structured tools and typed input', () => {
  const profile = { family: 'omni', modelCapabilities: { functionCalling: true },
    transportCapabilities: { imageBufferInput: true, textInput: true } }
  assert.deepEqual(visualFeatures({ provider: 'dashscope', modelProfile: profile }), {
    continuous: true, textInput: true, visualTools: true,
  })
  assert.deepEqual(visualFeatures({ provider: 'minicpm-o', modelProfile: {
    family: 'minicpm-o', modelCapabilities: { functionCalling: false },
    transportCapabilities: { imageBufferInput: true, textInput: false },
  } }), { continuous: true, textInput: false, visualTools: false })
  assert.deepEqual(visualFeatures(), { continuous: false, textInput: false, visualTools: false })
  assert.equal(visualFeatures({ provider: 'other', modelProfile: profile }).visualTools, false,
    'visual input alone does not imply compatibility with the bundled reader')
  assert.equal(visualFeatures({ provider: 'other', modelProfile: profile }).continuous, true,
    'continuous frames use Gateway capabilities, not a Qwen-only model list')
  assert.equal(visualFeatures({ provider: 'dashscope', modelProfile: { ...profile, family: 'audio' } }).visualTools, false)
})
