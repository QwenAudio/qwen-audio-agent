import assert from 'node:assert/strict'
import test from 'node:test'
import { backendEnvironment } from '../../shared/backend-environment.mjs'

const env = {
  PATH: '/usr/bin',
  HOME: '/home/user',
  LANG: 'zh_CN.UTF-8',
  DASHSCOPE_API_KEY: 'dashscope-secret',
  DEEPSEEK_API_KEY: 'deepseek-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  OPENCLAW_GATEWAY_TOKEN: 'openclaw-secret',
  QWEN_AUDIO_AGENT_AUTH_SECRET: 'identity-secret',
  QWEN_AUDIO_REALTIME_API_KEY: 'realtime-secret',
  QWEN_AUDIO_MEMORY_API_KEY: 'memory-secret',
  SPEECH_TO_SPEECH_AUTH_TOKEN: 'speech-secret',
}

test('projects only operating-system and selected backend environment', () => {
  const deepseek = backendEnvironment('deepseek', { env })
  assert.equal(deepseek.PATH, '/usr/bin')
  assert.equal(deepseek.DEEPSEEK_API_KEY, 'deepseek-secret')
  assert.equal(deepseek.DASHSCOPE_API_KEY, undefined)
  assert.equal(deepseek.OPENCLAW_GATEWAY_TOKEN, undefined)
  assert.equal(deepseek.QWEN_AUDIO_AGENT_AUTH_SECRET, undefined)
  assert.equal(deepseek.QWEN_AUDIO_REALTIME_API_KEY, undefined)
  assert.equal(deepseek.QWEN_AUDIO_MEMORY_API_KEY, undefined)
  assert.equal(deepseek.SPEECH_TO_SPEECH_AUTH_TOKEN, undefined)
})

test('keeps each backend credential namespace isolated', () => {
  assert.equal(
    backendEnvironment('claude', { env }).ANTHROPIC_API_KEY,
    'anthropic-secret',
  )
  assert.equal(
    backendEnvironment('openclaw', { env }).OPENCLAW_GATEWAY_TOKEN,
    'openclaw-secret',
  )
  assert.equal(
    backendEnvironment('opencode', { env }).DASHSCOPE_API_KEY,
    'dashscope-secret',
  )
  assert.equal(
    backendEnvironment('claude', { env }).DEEPSEEK_API_KEY,
    undefined,
  )
})

test('projects MiniMax Code variables without importing unrelated credentials', () => {
  const projected = backendEnvironment('minimax', {
    env: {
      ...env,
      MINIMAX_API_KEY: 'minimax-secret',
    },
  })
  assert.equal(projected.MINIMAX_API_KEY, 'minimax-secret')
  assert.equal(projected.ANTHROPIC_API_KEY, undefined)
  assert.equal(projected.DEEPSEEK_API_KEY, undefined)
  assert.equal(projected.QWEN_AUDIO_AGENT_AUTH_SECRET, undefined)
})

test('generic ACP forwards additional names only when explicitly requested', () => {
  const projected = backendEnvironment('acp', {
    env: {
      ...env,
      CUSTOM_AGENT_TOKEN: 'custom-secret',
      QWEN_AUDIO_AGENT_ACP_FORWARD_ENV: 'CUSTOM_AGENT_TOKEN',
    },
  })
  assert.equal(projected.CUSTOM_AGENT_TOKEN, 'custom-secret')
  assert.equal(projected.DASHSCOPE_API_KEY, undefined)
  assert.equal(projected.QWEN_AUDIO_AGENT_ACP_FORWARD_ENV, undefined)
})
