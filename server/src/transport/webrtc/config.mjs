export function webRtcOptions(env = process.env) {
  if (!['1', 'true'].includes(env.QWAUDIO_WEBRTC_ENABLED)) return null
  const iceServers = JSON.parse(env.QWAUDIO_WEBRTC_ICE_SERVERS || '[]')
  if (!Array.isArray(iceServers) || iceServers.length > 8) throw new TypeError('ICE servers must be a JSON array (max 8)')
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    if (!urls.length || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):/.test(url))) throw new TypeError('ICE servers require STUN or TURN URLs')
  }
  const iceTransportPolicy = env.QWAUDIO_WEBRTC_ICE_TRANSPORT_POLICY || 'all'
  if (!['all', 'relay'].includes(iceTransportPolicy)) throw new TypeError('invalid ICE transport policy')
  return { enabled: true, iceServers, iceTransportPolicy }
}

export function rtcError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}
