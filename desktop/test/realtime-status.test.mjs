import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gatewayStatusLabel,
  realtimeConnectionStatus,
  realtimeModelStatusLabel,
  realtimeModelRuntimeStatus,
  realtimeRuntimeLabel,
  realtimeStatusLabel,
} from '../src/realtime-status.mjs'
import * as realtimeStatus from '../src/realtime-status.mjs'
import {
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  resolveDashScopeRealtimeModelProfile,
} from '../../shared/realtime-provider-catalog.mjs'

test('uses compact realtime provider labels in the desktop status card', () => {
  assert.equal(realtimeStatusLabel('dashscope'), 'DashScope')
  assert.equal(
    realtimeStatusLabel('speech-to-speech'),
    'Speech-to-Speech',
  )
})

test('uses compact gateway and realtime runtime identities', () => {
  assert.equal(
    gatewayStatusLabel('http://127.0.0.1:3101/health'),
    '127.0.0.1:3101',
  )
  assert.equal(
    realtimeRuntimeLabel('dashscope', 'qwen-audio-3.0-realtime-plus'),
    'Qwen Audio 3.0 Plus',
  )
  assert.equal(
    realtimeRuntimeLabel('speech-to-speech', ''),
    'Speech-to-Speech',
  )
})

test('uses consistent product and version labels for known realtime models', () => {
  assert.equal(
    realtimeModelStatusLabel('qwen-audio-3.0-realtime-plus'),
    'Qwen Audio 3.0 Plus',
  )
  assert.equal(
    realtimeModelStatusLabel('qwen-audio-3.0-realtime-flash'),
    'Qwen Audio 3.0 Flash',
  )
  assert.equal(realtimeModelStatusLabel('custom-model'), 'custom-model')
})

test('uses the shared profile label and reports runtime model mismatch', () => {
  assert.equal(
    realtimeModelStatusLabel(DASHSCOPE_OMNI_PLUS_REALTIME_MODEL),
    'Qwen3.5 Omni Plus',
  )
  assert.deepEqual(realtimeModelRuntimeStatus({
    realtimeModel: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
    realtimeModelProfile: { id: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL },
  }, 'qwen-audio-3.0-realtime-plus'), {
    label: 'Qwen3.5 Omni Plus',
    mismatch: true,
  })
})

test('renders no DashScope model for missing metadata or Speech-to-Speech', () => {
  assert.deepEqual(realtimeModelRuntimeStatus({}, DEFAULT_DASHSCOPE_REALTIME_MODEL), {
    label: '',
    mismatch: false,
  })
  assert.deepEqual(realtimeModelRuntimeStatus({
    realtimeProvider: 'speech-to-speech',
    realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }, DEFAULT_DASHSCOPE_REALTIME_MODEL), {
    label: '',
    mismatch: false,
  })
})

test('derives truthful model and Desktop transport hints per profile', () => {
  assert.equal(typeof realtimeStatus.realtimeModelPresentation, 'function')

  assert.deepEqual(realtimeStatus.realtimeModelPresentation(
    resolveDashScopeRealtimeModelProfile(DASHSCOPE_OMNI_PLUS_REALTIME_MODEL),
  ), {
    optionHint: '模型：文字 / 语音 / 图片',
    selectedHint: '模型能力：文字 / 语音 / 图片 · Desktop 传输：文字 / 语音（图片 / 视频未启用）',
  })
  assert.deepEqual(realtimeStatus.realtimeModelPresentation(
    resolveDashScopeRealtimeModelProfile(DEFAULT_DASHSCOPE_REALTIME_MODEL),
  ), {
    optionHint: '模型：文字 / 语音',
    selectedHint: '模型能力：文字 / 语音 · Desktop 传输：文字 / 语音（图片 / 视频未启用）',
  })
})

test('returns an explicit not-applied outcome for a remote model mismatch', () => {
  assert.equal(typeof realtimeStatus.remoteRealtimeModelOutcome, 'function')

  assert.deepEqual(realtimeStatus.remoteRealtimeModelOutcome({
    realtimeProvider: 'dashscope',
    realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    realtimeModelProfile: { id: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL },
  }, {
    realtimeProvider: 'dashscope',
    realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }), {
    applied: false,
    reason: 'realtime-model-mismatch',
    message: `远程 Gateway 报告的 Realtime 模型 ${DASHSCOPE_OMNI_PLUS_REALTIME_MODEL} 与请求模型 ${DEFAULT_DASHSCOPE_REALTIME_MODEL} 不一致；设置未应用`,
    requestedRealtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    actualRealtimeModel: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  })
})

test('rejects a remote DashScope model when runtime metadata is missing', () => {
  assert.equal(typeof realtimeStatus.remoteRealtimeModelOutcome, 'function')

  assert.deepEqual(realtimeStatus.remoteRealtimeModelOutcome({
    realtimeProvider: 'dashscope',
  }, {
    realtimeProvider: 'dashscope',
    realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }), {
    applied: false,
    reason: 'realtime-model-unverifiable',
    message: '远程 Gateway 未报告 DashScope Realtime 模型；设置未应用',
    requestedRealtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    actualRealtimeModel: null,
  })
})

test('keeps a fatal realtime failure distinct from Gateway connectivity', () => {
  assert.equal(realtimeConnectionStatus(), 'configured')
  assert.equal(realtimeConnectionStatus({ connecting: 1 }), 'connecting')
  assert.equal(realtimeConnectionStatus({ connected: 1 }), 'connected')
  assert.equal(realtimeConnectionStatus({ unavailable: 1 }), 'unavailable')
  assert.equal(realtimeConnectionStatus({ disconnected: 1 }), 'disconnected')
})
