export const COCKPIT_CONNECTION_INTERRUPTED = '对话中控连接中断，正在重连'

export function publishCockpitVoiceIntent(client, muted, publishedMuted = null) {
  if (!client || publishedMuted === muted) return publishedMuted
  const sent = client.send({
    type: muted ? 'mute' : 'unmute',
  }) === true
  return sent ? muted : publishedMuted
}

export function cockpitVoiceConnectionMode(muted, outputVoice = '') {
  const enabled = muted !== true
  return {
    voiceEnabled: enabled,
    inputEnabled: enabled,
    outputEnabled: enabled,
    // `textOnly` describes a Client capability, not its current mute state.
    // Keeping it false lets a muted cockpit Client claim voice later through
    // the standard unmute event without reconnecting or changing protocol.
    textOnly: false,
    ...(outputVoice ? { outputVoice } : {}),
  }
}

export function cockpitConnectionError(state) {
  if (state === 'unavailable' || state === 'disconnected') {
    return COCKPIT_CONNECTION_INTERRUPTED
  }
  if (state === 'connected' || state === 'ready') return null
  return undefined
}
