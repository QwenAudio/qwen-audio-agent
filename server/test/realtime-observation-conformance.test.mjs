import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  resolveDashScopeRealtimeModelProfile,
} from '../../shared/realtime-model-catalog.mjs'
import { defaultRealtimeProviderRegistry } from '../src/voice/providers/registry.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { s2sProvider } from '../src/voice/providers/s2s.mjs'
import {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_BASE64_BYTES,
  OBSERVATION_MAX_FRAMES,
  RealtimeObservationRuntime,
} from '../src/voice/realtime-observation-runtime.mjs'

const JPEG = '/9j/fake'

const providerCases = [
  {
    name: 'DashScope Omni Flash',
    provider: dashscopeProvider,
    profile: resolveDashScopeRealtimeModelProfile(
      DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
    ),
    supportsObservation: true,
  },
  {
    name: 'DashScope Omni Plus',
    provider: dashscopeProvider,
    profile: resolveDashScopeRealtimeModelProfile(
      DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
    ),
    supportsObservation: true,
  },
  {
    name: 'DashScope Audio Plus',
    provider: dashscopeProvider,
    profile: resolveDashScopeRealtimeModelProfile(
      DEFAULT_DASHSCOPE_REALTIME_MODEL,
    ),
    supportsObservation: false,
  },
  {
    name: 'DashScope Audio Flash',
    provider: dashscopeProvider,
    profile: resolveDashScopeRealtimeModelProfile(
      DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
    ),
    supportsObservation: false,
  },
  {
    name: 'Speech-to-Speech',
    provider: s2sProvider,
    profile: null,
    supportsObservation: false,
  },
]

function fixture({ provider, profile }) {
  let now = 0
  const providerEvents = []
  const gatewayEvents = []
  const errors = []
  const frontend = {
    protocol: provider.protocol,
    transportCapabilities: profile?.transportCapabilities || {
      observationInput: false,
    },
    send: event => providerEvents.push(event),
  }
  const runtime = new RealtimeObservationRuntime({
    ensureFrontend: async () => {},
    getFrontend: () => frontend,
    send: event => gatewayEvents.push(event),
    onError: error => errors.push(error),
    now: () => now,
  })
  return {
    runtime,
    frontend,
    providerEvents,
    gatewayEvents,
    errors,
    setNow(value) {
      now = value
    },
  }
}

test('covers every registered Realtime Provider with an observation case', () => {
  const registered = defaultRealtimeProviderRegistry
    .list({ includeGatewayOnly: true })
    .map(provider => provider.key)
  assert.deepEqual(
    [...new Set(providerCases.map(item => item.provider.key))].sort(),
    registered.sort(),
  )
})

for (const item of providerCases) {
  test(`${item.name} observes only when its transport declares support`, async () => {
    const state = fixture(item)
    assert.equal(await state.runtime.start(), item.supportsObservation)

    if (!item.supportsObservation) {
      assert.equal(state.runtime.snapshot().state, 'unavailable')
      assert.equal(state.runtime.frame({ image: JPEG, sequence: 1 }), false)
      assert.equal(state.providerEvents.length, 0)
      assert.equal(state.errors.length, 1)
      return
    }

    assert.equal(state.runtime.frame({ image: JPEG, sequence: 1 }), true)
    state.setNow(OBSERVATION_INTERVAL_MS - 1)
    assert.equal(state.runtime.frame({ image: JPEG, sequence: 2 }), false)
    state.setNow(OBSERVATION_INTERVAL_MS)
    assert.equal(state.runtime.frame({ image: JPEG, sequence: 3 }), true)
    assert.deepEqual(
      state.providerEvents,
      [
        item.provider.protocol.imageAppend(JPEG),
        item.provider.protocol.imageAppend(JPEG),
      ],
    )
    assert.equal(
      state.providerEvents.some(event => event.type === 'response.create'),
      false,
    )

    state.setNow(OBSERVATION_INTERVAL_MS * 2)
    assert.equal(
      state.runtime.frame({
        image: `A${'a'.repeat(OBSERVATION_MAX_BASE64_BYTES)}`,
        sequence: 4,
      }),
      false,
    )
    assert.equal(state.errors.length, 1)
  })

  if (!item.supportsObservation) continue
  test(`${item.name} clears frames across stop and reconnect`, async () => {
    const state = fixture(item)
    await state.runtime.start()
    for (let sequence = 0; sequence < OBSERVATION_MAX_FRAMES; sequence += 1) {
      state.setNow(sequence * OBSERVATION_INTERVAL_MS)
      assert.equal(state.runtime.frame({ image: JPEG, sequence }), true)
    }
    assert.equal(state.runtime.snapshot().frames, OBSERVATION_MAX_FRAMES)

    state.runtime.stop('realtime_disconnected')
    assert.deepEqual(state.runtime.snapshot(), {
      state: 'idle',
      frames: 0,
      lastFrameAt: 0,
    })
    assert.equal(state.gatewayEvents.at(-1).reason, 'realtime_disconnected')

    assert.equal(await state.runtime.start(), true)
    assert.equal(state.runtime.snapshot().frames, 0)
    assert.equal(state.runtime.snapshot().state, 'active')
  })
}

