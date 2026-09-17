export class RealtimeConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RealtimeConfigurationError'
    this.code = 'REALTIME_CONFIGURATION_ERROR'
  }
}

export function isRecoverableRealtimeInactivityError(message) {
  const text = String(message || '').trim()
  return /session was closed because no response was generated for \d+ seconds/i.test(
    text,
  )
}
