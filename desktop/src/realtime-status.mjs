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
  return provider === 'speech-to-speech'
    ? 'Speech-to-Speech'
    : 'DashScope'
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
  return realtimeModelStatusLabel(model) || realtimeStatusLabel(provider)
}

export function realtimeModelRuntimeStatus(health, expectedModel = '') {
  if (health?.realtimeProvider === 'speech-to-speech') {
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
  const desktopInputs = enabledInputs(
    profile?.transportCapabilities,
    'nativeVideoInput',
  )
  return {
    optionHint: `模型：${modelInputs}`,
    selectedHint: `模型能力：${modelInputs} · Desktop 传输：${desktopInputs}（图片 / 视频未启用）`,
  }
}

export function remoteRealtimeModelOutcome(runtime, settings) {
  if (settings?.realtimeProvider !== 'dashscope') return null
  const requestedRealtimeModel = String(settings.realtimeModel || '').trim()
  const reportedModel = String(
    runtime?.realtimeModelProfile?.id || runtime?.realtimeModel || '',
  ).trim()
  const actualRealtimeModel = reportedModel || null
  if (!actualRealtimeModel) {
    return {
      applied: false,
      reason: 'realtime-model-unverifiable',
      message: '远程 Gateway 未报告 DashScope Realtime 模型；设置未应用',
      requestedRealtimeModel,
      actualRealtimeModel,
    }
  }
  if (actualRealtimeModel !== requestedRealtimeModel) {
    return {
      applied: false,
      reason: 'realtime-model-mismatch',
      message: `远程 Gateway 报告的 Realtime 模型 ${actualRealtimeModel} 与请求模型 ${requestedRealtimeModel} 不一致；设置未应用`,
      requestedRealtimeModel,
      actualRealtimeModel,
    }
  }
  return null
}

export function realtimeConnectionStatus(status) {
  if (!status) return 'configured'
  if (status.connected > 0) return 'connected'
  if (status.connecting > 0) return 'connecting'
  return status.unavailable > 0 ? 'unavailable' : 'disconnected'
}
