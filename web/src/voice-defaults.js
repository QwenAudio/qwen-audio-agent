export function initialVoiceEnabled({ desktopOrbMode = false, clientType = 'web' } = {}) {
  return desktopOrbMode === true || clientType === 'mobile'
}
