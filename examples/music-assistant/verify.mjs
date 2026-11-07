#!/usr/bin/env node
// Smoke test: connect to a running Gateway, complete the session.hello handshake,
// and assert session.ready. Usage: node verify.mjs [ws://host:port]
const gatewayOrigin = (process.argv[2] || process.env.GATEWAY_URL || 'ws://127.0.0.1:3101').replace(/\/$/, '')
const url = `${gatewayOrigin}/api/realtime?sessionId=music-assistant-verify-${Date.now()}`
const headers = process.env.QWEN_AUDIO_GATEWAY_ACCESS_TOKEN
  ? { Authorization: `Bearer ${process.env.QWEN_AUDIO_GATEWAY_ACCESS_TOKEN}` }
  : undefined

const ws = new WebSocket(url, { headers })
const fail = (message) => {
  console.error(`verify failed: ${message}`)
  try { ws.close() } catch {}
  process.exit(1)
}
const timer = setTimeout(() => fail(`no session.ready within 8s (${url})`), 8000)

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    type: 'session.hello',
    event_id: 'evt_verify_1',
    protocol: { min: '7.0.0', max: '7.0.0' },
    client: { type: 'mobile', version: '0.0.0-verify', instance_id: 'music_assistant_verify' },
    capabilities: ['input.audio', 'input.text'],
    locale: 'zh-CN',
    time_zone: 'Asia/Shanghai',
    connection: { voice_enabled: true, input_enabled: true, output_enabled: true, text_only: false },
  }))
})

ws.addEventListener('message', (event) => {
  let message
  try { message = JSON.parse(event.data) } catch { return }
  if (message.type === 'session.ready') {
    clearTimeout(timer)
    console.log('verify ok: session.ready received')
    console.log(`  protocol_version: ${message.protocol_version}`)
    console.log(`  session_id: ${message.session_id}`)
    console.log(`  capabilities: ${(message.capabilities || []).join(', ')}`)
    ws.close()
    process.exit(0)
  }
  if (message.type === 'error') {
    clearTimeout(timer)
    fail(`gateway error event: ${JSON.stringify(message)}`)
  }
})

ws.addEventListener('error', (event) => {
  clearTimeout(timer)
  fail(`websocket error: ${event.message || event.error?.message || 'unknown'} (${url}). Is the Gateway running?`)
})

ws.addEventListener('close', (event) => {
  clearTimeout(timer)
  if (event.code !== 1000) fail(`websocket closed before handshake: code=${event.code} reason=${event.reason || '-'}`)
})
