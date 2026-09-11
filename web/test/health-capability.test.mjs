import assert from 'node:assert/strict'
import test from 'node:test'
import * as voice from '../src/realtime/useRealtimeVoice.js'

function realtimeModelStatus(...args) {
  assert.equal(typeof voice.realtimeModelStatus, 'function')
  return voice.realtimeModelStatus(...args)
}

const FLASH_ID = 'qwen3.5-omni-flash-realtime'
const PLUS_ID = 'qwen3.5-omni-plus-realtime'
const LEGACY_ID = 'qwen-audio-3.0-realtime-plus'

function profile(id, label, {
  imageInput = false,
  videoInput = false,
  transportImageInput = false,
  imageBufferInput = false,
} = {}) {
  return {
    id,
    label,
    family: imageInput ? 'omni' : 'audio',
    modelCapabilities: {
      textInput: true,
      audioInput: true,
      imageInput,
      videoInput,
    },
    transportCapabilities: {
      textInput: true,
      audioInput: true,
      imageInput: transportImageInput,
      imageBufferInput,
    },
  }
}

const flash = profile(FLASH_ID, 'Qwen3.5 Omni Flash Realtime', {
  imageInput: true,
  videoInput: true,
  imageBufferInput: true,
})
const plus = profile(PLUS_ID, 'Qwen3.5 Omni Plus Realtime', {
  imageInput: true,
  videoInput: true,
  imageBufferInput: true,
})
const legacy = profile(LEGACY_ID, 'Qwen Audio 3.0 Realtime Plus')
const catalog = [flash, plus, legacy]

for (const activeProfile of [flash, plus]) {
  test(`separates ${activeProfile.label} model support from Web transport`, () => {
    const status = realtimeModelStatus({
      realtimeModel: activeProfile.id,
      realtimeModelProfile: activeProfile,
      realtimeModelCatalog: catalog,
    })

    assert.equal(status.label, activeProfile.label)
    assert.equal(status.metadataStatus, 'current')
    assert.deepEqual(status.modelInputModes, ['text', 'audio', 'image', 'video'])
    assert.deepEqual(status.transportInputModes, ['text', 'audio', 'video'])
    assert.equal(status.imageInputEnabled, false)
  })
}

test('shows the legacy model without claiming image support', () => {
  const status = realtimeModelStatus({
    realtimeModel: legacy.id,
    realtimeModelProfile: legacy,
    realtimeModelCatalog: catalog,
  })

  assert.equal(status.label, legacy.label)
  assert.deepEqual(status.modelInputModes, ['text', 'audio'])
  assert.deepEqual(status.transportInputModes, ['text', 'audio'])
  assert.equal(status.imageInputEnabled, false)
})

test('fails closed when model profile metadata is missing', () => {
  const status = realtimeModelStatus({
    realtimeModel: PLUS_ID,
    realtimeModelCatalog: catalog,
  })

  assert.equal(status.id, PLUS_ID)
  assert.equal(status.label, PLUS_ID)
  assert.equal(status.metadataStatus, 'missing')
  assert.deepEqual(status.modelInputModes, [])
  assert.deepEqual(status.transportInputModes, [])
  assert.equal(status.imageInputEnabled, false)
})

test('rejects stale profile capabilities when the active model changed', () => {
  const stalePlus = profile(PLUS_ID, plus.label, {
    imageInput: true,
    transportImageInput: true,
  })
  const status = realtimeModelStatus({
    realtimeModel: FLASH_ID,
    realtimeModelProfile: stalePlus,
    realtimeModelCatalog: catalog,
  })

  assert.equal(status.id, FLASH_ID)
  assert.equal(status.label, FLASH_ID)
  assert.equal(status.metadataStatus, 'stale')
  assert.deepEqual(status.modelInputModes, [])
  assert.deepEqual(status.transportInputModes, [])
  assert.equal(status.imageInputEnabled, false)
})

test('enables image controls only for current exact catalog transport truth', () => {
  const future = profile('future-image-model', 'Future image model', {
    imageInput: true,
    transportImageInput: true,
  })
  const status = realtimeModelStatus({
    realtimeModel: future.id,
    realtimeModelProfile: future,
    realtimeModelCatalog: [future],
  })

  assert.equal(status.imageInputEnabled, true)
  assert.deepEqual(status.transportInputModes, ['text', 'audio', 'image'])
})
