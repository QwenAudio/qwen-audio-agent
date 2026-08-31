export function cockpitVoiceConnectionMode(muted) {
  const enabled = muted !== true
  return {
    voiceEnabled: enabled,
    inputEnabled: enabled,
    outputEnabled: enabled,
    // `textOnly` describes a Client capability, not its current mute state.
    // Keeping it false lets a muted cockpit Client claim voice later through
    // the standard unmute event without reconnecting or changing protocol.
    textOnly: false,
  }
}
