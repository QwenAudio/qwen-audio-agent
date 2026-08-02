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
