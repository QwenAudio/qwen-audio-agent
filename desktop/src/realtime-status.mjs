export function realtimeStatusLabel(provider) {
  return provider === 'speech-to-speech'
    ? 'Speech-to-Speech'
    : 'Qwen Audio'
}

export function realtimeModelStatusLabel(model) {
  const value = String(model || '').trim()
  if (value === 'qwen-audio-3.0-realtime-plus') return 'plus'
  if (value === 'qwen-audio-3.0-realtime-flash') return 'flash'
  return value
}

export function realtimeConnectionStatus(status) {
  if (!status) return 'configured'
  if (status.connected > 0) return 'connected'
  if (status.connecting > 0) return 'connecting'
  return status.unavailable > 0 ? 'unavailable' : 'disconnected'
}
