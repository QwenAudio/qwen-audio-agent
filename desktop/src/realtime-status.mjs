import { realtimeModelCatalog, resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { REALTIME_PROVIDERS, DEFAULT_REALTIME_PROVIDER } from '../../shared/realtime-provider-definitions.mjs'

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
  const definition = REALTIME_PROVIDERS.find(item => item.key === (provider || DEFAULT_REALTIME_PROVIDER))
  return definition?.displayLabel || definition?.label || provider
}

export function realtimeModelStatusLabel(model, provider = 'dashscope') {
  const value = String(model || '').trim()
  if (!value) return ''
  const profile = resolveRealtimeModelProfile(value, provider)
  return profile.family === 'unknown'
    ? profile.label
    : profile.label.replace(/\s+Realtime\b/i, '')
}

export function realtimeRuntimeLabel(provider, model) {
  const definition = REALTIME_PROVIDERS.find(item => item.key === provider)
  if (definition?.modelLabel) return definition.modelLabel
  if (!realtimeModelCatalog(provider)) return realtimeStatusLabel(provider)
  return realtimeModelStatusLabel(model, provider) || realtimeStatusLabel(provider)
}

export function realtimeModelRuntimeStatus(health, expectedModel = '') {
  if (health?.realtimeProvider && !realtimeModelCatalog(health.realtimeProvider)) {
    return { label: '', mismatch: false }
  }
  const actualModel = String(
    health?.realtimeModelProfile?.id || health?.realtimeModel || '',
  ).trim()
  const expected = String(expectedModel || '').trim()
  return {
    label: realtimeModelStatusLabel(actualModel, health?.realtimeProvider),
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
