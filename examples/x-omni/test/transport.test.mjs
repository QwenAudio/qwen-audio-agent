import test from 'node:test'
import assert from 'node:assert/strict'
import { xOmniTransport, validateTransport } from '../transport.mjs'
import { BrowserWebRtcConnection } from '../../../shared/gateway/webrtc-browser.mjs'

test('WebSocket remains the default; WebRTC is explicit and never changes provider silently', () => {
  assert.equal(xOmniTransport(), 'websocket')
  assert.equal(xOmniTransport(['--webrtc']), 'webrtc')
  assert.throws(() => xOmniTransport(['--invalid']), /Usage/)
  validateTransport('websocket', 'minicpm-o')
  validateTransport('webrtc', 'dashscope')
  assert.throws(() => validateTransport('webrtc', 'minicpm-o'), /WebSocket/)
  assert.throws(() => validateTransport('invalid', 'dashscope'), /Unsupported/)
})

function connection(options = {}) {
  return new BrowserWebRtcConnection({ audio: { setAttribute() {}, pause() {} }, ...options })
}

test('late microphone grants are stopped; concurrent enable does not ask permission twice', async () => {
  let resolve, requests = 0, stopped = 0, replacements = 0
  const mediaDevices = { getUserMedia: () => { requests++; return new Promise(done => { resolve = done }) } }
  const client = connection({ mediaDevices })
  client.audioSender = { replaceTrack: async () => { replacements++ } }
  const first = client.setMicrophoneEnabled(true)
  const second = client.setMicrophoneEnabled(true)
  assert.equal(requests, 1)
  await client.close()
  resolve({ getTracks: () => [{ stop() { stopped++ } }] })
  await Promise.all([first, second])
  assert.equal(stopped, 1)
  assert.equal(replacements, 0)
})

test('mute and input suspension do not close the session or stop audio playback', async () => {
  let paused = 0
  const client = connection({ audio: { setAttribute() {}, pause() { paused++ } } })
  const microphone = { enabled: true, stop() {} }
  const video = { enabled: true }
  client.microphone = { getAudioTracks: () => [microphone], getTracks: () => [microphone] }
  client.videoSender = { track: video, replaceTrack: async () => {} }
  client.ready = true
  await client.setMicrophoneEnabled(false)
  assert.equal(microphone.enabled, false)
  assert.equal(client.closed, false)
  assert.equal(paused, 0)
  client.received({ type: 'qwaudio.event', event: { type: 'input.suspend' } })
  assert.equal(video.enabled, false)
  client.received({ type: 'qwaudio.event', event: { type: 'input.resume' } })
  assert.equal(video.enabled, true)
  assert.equal(microphone.enabled, false, 'resume respects explicit mute')
  await client.close()
})

test('closing is idempotent and stale events cannot reopen the client', async () => {
  let releases = 0, states = 0
  const client = connection({ fetch: async () => { releases++ }, onState: () => { states++ } })
  client.location = '/api/v1/webrtc/realtime/test'
  await Promise.all([client.close(), client.close()])
  client.received({ type: 'session.updated' })
  assert.equal(client.ready, false)
  assert.equal(states, 1)
  assert.equal(releases, 1)
})

test('reusing an audio element after interruption restores playback', async () => {
  const audio = { muted: true, setAttribute() {}, pause() {} }
  const client = connection({ audio })
  assert.equal(audio.muted, false)
  await client.close()
})
