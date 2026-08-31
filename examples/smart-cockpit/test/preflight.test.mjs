import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAgentConfigured,
  assertRealtimeConfigured,
  cockpitEndpoints,
  preflightCockpitExample,
} from '../preflight.mjs'

test('requires an actionable Realtime configuration before starting services', () => {
  assert.throws(
    () => assertRealtimeConfigured({}),
    /examples\/smart-cockpit\/\.env\.local/,
  )
  assert.doesNotThrow(() => assertRealtimeConfigured({
    DASHSCOPE_API_KEY: 'configured',
  }))
  assert.doesNotThrow(() => assertRealtimeConfigured({
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
    SPEECH_TO_SPEECH_REALTIME_URL: 'ws://127.0.0.1:8765/v1/realtime',
  }))
})

test('requires a DashScope credential for the model-powered backend Agent', () => {
  assert.throws(
    () => assertAgentConfigured({}),
    /后台 Agent 缺少 DASHSCOPE_API_KEY/u,
  )
  assert.doesNotThrow(() => assertAgentConfigured({
    DASHSCOPE_API_KEY: 'configured',
  }))
})

test('validates all four configured endpoints before concurrent startup', async () => {
  const checked = []
  const env = {
    DASHSCOPE_API_KEY: 'configured',
    COCKPIT_SERVICE_PORT: '13010',
    COCKPIT_AGENT_PORT: '13020',
    COCKPIT_GATEWAY_PORT: '18889',
    COCKPIT_CLIENT_PORT: '15173',
  }
  const endpoints = await preflightCockpitExample({
    env,
    probePort: async endpoint => checked.push(endpoint),
  })

  assert.deepEqual(checked, endpoints)
  assert.deepEqual(endpoints.map(row => row.port), [13010, 13020, 18889, 15173])
})

test('rejects invalid endpoint ports without starting a process', () => {
  assert.throws(
    () => cockpitEndpoints({ COCKPIT_SERVICE_PORT: '0' }),
    /COCKPIT_SERVICE_PORT/,
  )
})
