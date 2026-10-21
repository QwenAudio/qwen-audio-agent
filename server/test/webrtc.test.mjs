import test from 'node:test'
import assert from 'node:assert/strict'
import { WebRtcConnection } from '../src/transport/webrtc/protocol.mjs'
import { webRtcOptions } from '../src/transport/webrtc/config.mjs'
import { PcmResampler, encodePcm, decodePcm } from '../src/transport/webrtc/pcm.mjs'
import { rtcHarness, FakeMedia, testProvider, waitUntil, OFFER, JPEG } from './fixtures/webrtc-gateway.mjs'

test('WebRTC defaults to disabled and validates opt-in ICE configuration', () => {
  assert.equal(webRtcOptions({}), null)
  assert.equal(webRtcOptions({ QWAUDIO_WEBRTC_ICE_SERVERS: 'invalid' }), null)
  assert.deepEqual(webRtcOptions({ QWAUDIO_WEBRTC_ENABLED: '1' }).iceServers, [])
  assert.throws(() => webRtcOptions({ QWAUDIO_WEBRTC_ENABLED: '1', QWAUDIO_WEBRTC_ICE_SERVERS: '[{"urls":"https://invalid"}]' }))
})

test('PCM preserves byte order, stereo folding and streaming boundaries', () => {
  const samples = Int16Array.from([-32768, -123, 0, 123, 32767])
  assert.deepEqual(decodePcm(encodePcm(samples)), samples)
  assert.throws(() => decodePcm('AQ=='), /even/)
  assert.deepEqual(new PcmResampler(16000, 16000).push(Int16Array.from([100, -100, 600, 200]), 2), Int16Array.from([0, 400]))
  const input = Int16Array.from({ length: 4800 }, (_, i) => Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 48000)))
  const once = new PcmResampler(48000, 16000)
  const expected = [...once.push(input), ...once.finish()]
  const stream = new PcmResampler(48000, 16000)
  const actual = []
  for (let offset = 0; offset < input.length; offset += 137) actual.push(...stream.push(input.subarray(offset, offset + 137)))
  actual.push(...stream.finish())
  assert.deepEqual(actual, expected)
  assert.ok(Math.abs(actual.length - 1600) <= 1)
})

test('PCM downsampling attenuates frequencies above destination Nyquist', () => {
  const input = Int16Array.from({ length: 4800 }, (_, i) => Math.round(10000 * Math.sin(i * 2 * Math.PI * 12000 / 48000)))
  const output = new PcmResampler(48000, 16000).push(input).subarray(100)
  const rms = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0) / output.length)
  assert.ok(rms < 500, `out-of-band RMS ${rms}`)
})

test('vendor-style text is staged until response.create; unsupported controls error', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'test' })
  const inputs = []
  connection.on('message', raw => inputs.push(JSON.parse(raw)))
  connection.receive(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } }))
  assert.equal(inputs.length, 0)
  assert.equal(media.events.at(-1).type, 'conversation.item.created')
  connection.receive('{"type":"response.create"}')
  assert.equal(inputs[0].text, 'Hello')
  connection.receive('{"type":"session.update","session":{"instructions":"replace gateway"}}')
  assert.equal(media.events.at(-1).error.code, 'invalid_event')
  connection.receive('{"type":"input_audio_buffer.commit"}')
  assert.equal(media.events.at(-1).error.code, 'unsupported_event')
  connection.close()
})

test('generation and send completion never manufacture playback receipts', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'test' })
  const inputs = []
  connection.on('message', raw => inputs.push(JSON.parse(raw)))
  connection.send(JSON.stringify({ type: 'audio.delta', audio: 'AAAAAA==', sampleRate: 24000, responseId: 'r1' }))
  connection.send(JSON.stringify({ type: 'audio.done', responseId: 'r1' }))
  connection.onResponseDone({ id: 'r1', status: 'failed' })
  assert.equal(inputs.length, 0)
  assert.equal(media.events.at(-1).response.status, 'failed')
  connection.receive('{"type":"qwaudio.playback.started","response_id":"r1"}')
  assert.equal(inputs[0].type, 'playback.started')
  connection.close()
})

test('disabled ingress leaves endpoints absent without loading native dependencies', async t => {
  const h = await rtcHarness(t, { options: { enabled: false } })
  assert.equal((await h.offer()).status, 404)
  assert.equal((await fetch(`${h.base}/api/realtime/webrtc/example`, { headers: h.headers })).status, 404)
  assert.equal(h.media.length, 0)
})

test('example assets are served from examples/webrtc with authentication, not as a directory', async t => {
  const h = await rtcHarness(t)
  const page = await fetch(`${h.base}/api/realtime/webrtc/example`, { headers: h.headers })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /examples\/webrtc/)
  const client = await fetch(`${h.base}/api/realtime/webrtc/example.mjs`, { headers: h.headers })
  assert.equal(client.status, 200)
  assert.match(await client.text(), /BrowserWebRtcConnection/)
  for (const name of ['webrtc-browser.mjs', 'webrtc-message.mjs']) {
    assert.equal((await fetch(`${h.base}/api/realtime/webrtc/${name}`, { headers: h.headers })).status, 200)
    assert.equal((await fetch(`${h.base}/api/realtime/webrtc/${name}`)).status, 401)
  }
  assert.equal((await fetch(`${h.base}/api/realtime/webrtc/example`)).status, 401)
  assert.equal((await fetch(`${h.base}/api/realtime/webrtc/example/.env`, { headers: h.headers })).status, 404)
})

test('auth, content-type, SDP, model and video are checked before allocation', async t => {
  const h = await rtcHarness(t)
  assert.equal((await h.offer(OFFER, '', { Authorization: '' })).status, 401)
  assert.equal((await h.offer(OFFER, '', { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await h.offer('not sdp')).status, 400)
  assert.equal((await h.offer(OFFER, '?model=wrong')).status, 400)
  assert.equal((await h.offer(OFFER, '?sessionId=../other')).status, 400)
  assert.equal((await h.offer(`${OFFER}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`)).status, 400)
  assert.equal((await h.offer('v=0' + 'x'.repeat(65536))).status, 413)
  assert.equal(h.media.length, 0)
})

for (const video of [false, true]) {
  test(`${video ? 'Omni' : 'Audio'} ingress reuses voice, text, output and playback session paths`, async t => {
    const h = await rtcHarness(t, { video })
    const response = await h.offer(video ? `${OFFER}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n` : OFFER, '?sessionId=conversation-1')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/sdp/)
    const media = h.media[0]
    media.onOpen()
    await waitUntil(() => media.events.some(event => event.type === 'session.updated'))
    assert.equal(media.events.find(event => event.type === 'session.created').session.id, 'conversation-1')
    media.onAudio('AAAAAA==')
    await waitUntil(() => h.frontends[0].audio.length > 0)
    media.onImage(JPEG)
    assert.equal(h.frontends[0].images.length, video ? 1 : 0)
    media.onEvent(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello test' }] } }))
    media.onEvent('{"type":"response.create"}')
    await waitUntil(() => h.frontends[0].inputs.length === 1)
    const frontend = h.frontends[0]
    const context = frontend.inputs[0].context
    frontend.emit({ type: 'response.created', response: { id: 'reply1' }, __voiceContext: context })
    frontend.emit({ type: 'response.audio.delta', response_id: 'reply1', delta: 'AAAAAA==' })
    frontend.emit({ type: 'response.audio_transcript.done', response_id: 'reply1', transcript: 'Synthetic reply' })
    assert.equal(media.events.some(event => event.type === 'response.audio_transcript.done'), false)
    media.onEvent('{"type":"qwaudio.playback.started","response_id":"reply1"}')
    assert.equal(media.events.find(event => event.type === 'response.audio_transcript.done').transcript, 'Synthetic reply')
    frontend.emit({ type: 'response.done', response: { id: 'reply1', status: 'completed' } })
    assert.equal(media.events.find(event => event.type === 'response.done').response.status, 'completed')
    assert.equal(media.chunks[0].sampleRate, 24000)
    media.onEvent('{"type":"qwaudio.playback.ended","response_id":"reply1"}')
    media.onEvent('{"type":"response.cancel"}')
    assert.ok(media.clearCount > 0)
    const deleted = await fetch(h.base + response.headers.get('location'), { method: 'DELETE', headers: h.headers })
    assert.equal(deleted.status, 204)
    assert.equal(h.ingress.status().connections, 0)
  })
}

test('pending peer credentials can be revoked before the DataChannel opens', async t => {
  const h = await rtcHarness(t)
  assert.equal((await h.offer()).status, 200)
  assert.equal(h.gateway.disconnectCredential('rtc-credential'), 1)
  assert.equal(h.ingress.status().connections, 0)
  assert.equal(h.media[0].closed, true)
  h.media[0].onOpen()
  assert.equal(h.frontends.length, 0)
})

test('owner isolation, quota, delete and negotiation timeout release resources', async t => {
  const h = await rtcHarness(t, { options: { maxConnections: 1, connectTimeoutMs: 150 } })
  const response = await h.offer()
  assert.equal(response.status, 200)
  assert.equal((await h.offer()).status, 429)
  const other = await fetch(h.base + response.headers.get('location'), { method: 'DELETE', headers: { ...h.headers, 'x-test-owner': 'different-owner' } })
  assert.equal(other.status, 404)
  await waitUntil(() => h.ingress.status().connections === 0)
  assert.equal(h.media[0].closed, true)
})

test('content-safety recovery stays on the shared runtime and clears RTC output', async t => {
  const h = await rtcHarness(t)
  await h.offer()
  const media = h.media[0]
  media.onOpen()
  await waitUntil(() => h.frontends[0]?.ready)
  media.onEvent(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic rejected turn' }] } }))
  media.onEvent('{"type":"response.create"}')
  await waitUntil(() => h.frontends[0].inputs.length === 1)
  const frontend = h.frontends[0]
  frontend.emit({ type: 'response.created', response: { id: 'rejected' }, __voiceContext: frontend.inputs[0].context })
  frontend.emit({ type: 'error', response_id: 'rejected', error: { code: 'DataInspectionFailed', message: 'synthetic safety rejection' } })
  await waitUntil(() => h.frontends.length === 2)
  assert.ok(media.events.some(event => event.type === 'output_audio_buffer.cleared'))
  assert.equal(h.frontends[1].agentContext.recentMessages.some(message => message.content === 'synthetic rejected turn'), false)
})
