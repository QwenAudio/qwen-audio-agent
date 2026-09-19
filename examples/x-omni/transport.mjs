export function xOmniTransport(args = []) {
  if (args.length === 0) return 'websocket'
  if (args.length === 1 && args[0] === '--webrtc') return 'webrtc'
  throw new Error('Usage: npm run example:x-omni [-- --webrtc]')
}

export function validateTransport(transport, provider) {
  if (!['websocket', 'webrtc'].includes(transport)) throw new Error(`Unsupported X-Omni transport: ${transport}`)
  if (transport === 'webrtc' && provider !== 'dashscope') {
    throw new Error('X-Omni WebRTC currently supports Qwen Omni only. Use WebSocket for MiniCPM-o; no automatic provider fallback is performed.')
  }
}
