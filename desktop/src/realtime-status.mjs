import { resolveDashScopeRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'

export function gatewayStatusLabel(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return new URL(text).host
  } catch {
    return text
  }
}

export function realtimeStatusLabel(provider) {
  if (provider === 'speech-to-speech') return 'Speech-to-Speech'
  if (provider === 'minicpm-o') return '面壁智能'
  return 'DashScope'
}

export function realtimeModelStatusLabel(model) {
  const value = String(model || '').trim()
  if (!value) return ''
  const profile = resolveDashScopeRealtimeModelProfile(value)
  return profile.family === 'unknown'
    ? profile.label
    : profile.label.replace(/\s+Realtime\b/i, '')
}

export function realtimeRuntimeLabel(provider, model) {
  if (provider === 'minicpm-o') return 'MiniCPM-o 4.5'
  if (provider !== 'dashscope') return realtimeStatusLabel(provider)
  return realtimeModelStatusLabel(model) || realtimeStatusLabel(provider)
}

export function realtimeModelRuntimeStatus(health, expectedModel = '') {
  if (['speech-to-speech', 'minicpm-o'].includes(health?.realtimeProvider)) {
    return { label: '', mismatch: false }
  }
  const actualModel = String(
    health?.realtimeModelProfile?.id || health?.realtimeModel || '',
  ).trim()
  const expected = String(expectedModel || '').trim()
  return {
    label: realtimeModelStatusLabel(actualModel),
    mismatch: Boolean(expected && actualModel && expected !== actualModel),
  }
}

function enabledInputs(capabilities, videoKey = 'videoInput') {
  return [
    capabilities?.textInput && '文字',
    capabilities?.audioInput && '语音',
    capabilities?.imageInput && '图片',
    capabilities?.[videoKey] && '视频',
  ].filter(Boolean).join(' / ')
}

export function realtimeModelPresentation(profile) {
  const modelInputs = enabledInputs(profile?.modelCapabilities)
  const desktopInputs = enabledInputs(profile?.transportCapabilities)
  return {
    optionHint: `模型：${modelInputs}`,
    selectedHint: `模型能力：${modelInputs} · Desktop 传输：${desktopInputs}（图片 / 视频未启用）`,
  }
}

export function realtimeConnectionStatus(status) {
  if (!status) return 'configured'
  if (status.connected > 0) return 'connected'
  if (status.connecting > 0) return 'connecting'
  return status.unavailable > 0 ? 'unavailable' : 'disconnected'
}
