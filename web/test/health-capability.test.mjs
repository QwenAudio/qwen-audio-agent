import assert from 'node:assert/strict'
import test from 'node:test'
import * as voice from '../src/useRealtimeVoice.js'

function realtimeModelStatus(...args) {
  assert.equal(typeof voice.realtimeModelStatus, 'function')
  return voice.realtimeModelStatus(...args)
}

function realtimeProviderSelection(...args) {
  assert.equal(typeof voice.realtimeProviderSelection, 'function')
  return voice.realtimeProviderSelection(...args)
}

function realtimeProviderForConnection(...args) {
  assert.equal(typeof voice.realtimeProviderForConnection, 'function')
  return voice.realtimeProviderForConnection(...args)
}

const FLASH_ID = 'qwen3.5-omni-flash-realtime'
const PLUS_ID = 'qwen3.5-omni-plus-realtime'
const LEGACY_ID = 'qwen-audio-3.0-realtime-plus'

function profile(id, label, {
  imageInput = false,
  videoInput = false,
  transportImageInput = false,
  transportObservationInput = false,
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
      observationInput: transportObservationInput,
      nativeVideoInput: false,
    },
  }
}

const flash = profile(FLASH_ID, 'Qwen3.5 Omni Flash Realtime', {
  imageInput: true,
})
const plus = profile(PLUS_ID, 'Qwen3.5 Omni Plus Realtime', {
  imageInput: true,
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
    assert.deepEqual(status.modelInputModes, ['text', 'audio', 'image'])
    assert.deepEqual(status.transportInputModes, ['text', 'audio'])
    assert.equal(status.imageInputEnabled, false)
    assert.equal(status.observationInputEnabled, false)
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
  assert.equal(status.observationInputEnabled, false)
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
  assert.equal(status.observationInputEnabled, false)
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
  assert.equal(status.observationInputEnabled, false)
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
  assert.equal(status.observationInputEnabled, false)
})

test('enables continuous observation only for current exact transport truth', () => {
  const observable = profile('observable-model', 'Observable model', {
    imageInput: true,
    transportObservationInput: true,
  })
  const status = realtimeModelStatus({
    realtimeModel: observable.id,
    realtimeModelProfile: observable,
    realtimeModelCatalog: [observable],
  })

  assert.equal(status.observationInputEnabled, true)
  assert.deepEqual(status.transportInputModes, ['text', 'audio', 'observation'])
})

test('keeps an advertised provider selection separate from the model', () => {
  assert.deepEqual(realtimeProviderSelection('speech-to-speech', {
    realtimeProvider: 'dashscope',
    realtimeModelProfile: plus,
    realtimeProviders: [
      { key: 'dashscope', label: 'DashScope' },
      { key: 'speech-to-speech', label: 'Speech-to-Speech' },
    ],
  }), {
    provider: 'speech-to-speech',
    recovered: false,
    notice: '',
  })
})

test('recovers stale and unadvertised providers to the server default', () => {
  const health = {
    realtimeProvider: 'dashscope',
    realtimeModelProfile: plus,
    realtimeProviders: [{ key: 'dashscope', label: 'DashScope' }],
  }

  const selection = realtimeProviderSelection('removed-provider', health)
  assert.equal(selection.provider, '')
  assert.equal(selection.recovered, true)
  assert.equal(selection.notice, '已恢复为服务器默认前台')
  assert.ok(selection.notice.length <= 32)
})

test('recovers an advertised provider that explicitly excludes the active model', () => {
  const selection = realtimeProviderSelection('speech-to-speech', {
    realtimeProvider: 'dashscope',
    realtimeModelProfile: plus,
    realtimeProviders: [
      { key: 'dashscope', label: 'DashScope' },
      {
        key: 'speech-to-speech',
        label: 'Speech-to-Speech',
        realtimeModelIds: [LEGACY_ID],
      },
    ],
  })

  assert.deepEqual(selection, {
    provider: '',
    recovered: true,
    notice: '已恢复为服务器默认前台',
  })
})

test('does not connect with a persisted provider before fresh health validation', () => {
  assert.equal(
    realtimeProviderForConnection('speech-to-speech', false),
    '',
  )
  assert.equal(
    realtimeProviderForConnection('speech-to-speech', true),
    'speech-to-speech',
  )
})
