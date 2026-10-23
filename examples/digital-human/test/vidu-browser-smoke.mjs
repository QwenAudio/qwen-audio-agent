// Offline acceptance of the real adapter/control flow. ARTC transport is a
// fake SDK producing real MediaStream tracks; all playback uses Chromium's
// actual WebAudio graph. This is NOT a real Vidu/ARTC service test.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { chromium } from 'playwright'
import { startExampleServer } from '../server/server.mjs'

const wait = async fn => {
  const deadline = Date.now() + 15000
  while (!fn()) { if (Date.now() > deadline) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise(resolve => gateway.once('listening', resolve))
const events = [], controls = [], upstreams = []
let reply = 0, live = 0
const emit = (socket, event) => socket.send(JSON.stringify({ event_id: randomUUID(), ...event }))
gateway.on('connection', socket => socket.on('message', raw => {
  const event = JSON.parse(raw); events.push(event)
  if (event.type === 'session.hello') {
    emit(socket, { type: 'session.ready', request_event_id: event.event_id, protocol_version: event.protocol.max,
      session_id: 'vidu-browser', capabilities: event.capabilities })
    emit(socket, { type: 'voice.ready', inputSampleRate: 16000 })
  }
  if (event.type === 'text.message') {
    const responseId = `r${++reply}`
    emit(socket, { type: 'playback.clear' })
    emit(socket, { type: 'audio.delta', responseId, sampleRate: 24000, audio: Buffer.alloc(4800).toString('base64') })
    emit(socket, { type: 'audio.done', responseId })
  }
}))
const viduHttp = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume uploaded character data */ }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    live: { id: `live${++live}` }, client_secret: 'private-fake-secret',
  }))
})
const viduWs = new WebSocketServer({ server: viduHttp })
viduWs.on('connection', socket => {
  upstreams.push(socket)
  socket.on('message', (raw, binary) => {
    if (binary) return
    const event = JSON.parse(raw); controls.push(event)
    if (event.type === 1) socket.send(JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } }))
  })
})
await new Promise(resolve => viduHttp.listen(0, '127.0.0.1', resolve))
const sdk = `
window.__rtcEngines = [];
window.AliRtcEngine = {
  isSupported: async () => ({support:true}),
  getInstance() {
    const context = new AudioContext(); void context.resume();
    const destination = context.createMediaStreamDestination();
    const tone = context.createOscillator(); tone.frequency.value = 440;
    tone.connect(destination); tone.start();
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
    canvas.getContext('2d').fillRect(0,0,40,40);
    const videoStream = canvas.captureStream(25); const handlers = {};
    const engine = {
      volume: 0, destroyed: false,
      on: (name,fn) => {handlers[name]=fn},
      setPlayoutVolume(volume) { this.volume=volume },
      getAudioTrack: async () => destination.stream.getAudioTracks()[0],
      setRemoteViewConfig(video) {
        video.srcObject = videoStream;
        video.play = window.__blockArtcVideo ? () => Promise.reject(new Error('blocked')) : HTMLMediaElement.prototype.play.bind(video);
      },
      setChannelProfile(){}, publishLocalAudioStream(){}, publishLocalVideoStream(){}, enableLocalVideo(){},
      setDefaultSubscribeAllRemoteAudioStreams(){}, setDefaultSubscribeAllRemoteVideoStreams(){},
      async joinChannel() { handlers.audioSubscribeStateChanged(''+window.__avatarId,0,3); handlers.videoSubscribeStateChanged(''+window.__avatarId,0,3); },
      async leaveChannel(){}, async destroy() {
        this.destroyed=true; tone.stop(); videoStream.getTracks().forEach(t=>t.stop());
        destination.stream.getTracks().forEach(t=>t.stop()); await context.close();
      }
    };
    window.__rtcEngines.push(engine); return engine;
  }
};`
let host, browser
try {
  host = await startExampleServer({ port: 0, rendererId: 'vidu',
    gatewayUrl: `ws://127.0.0.1:${gateway.address().port}/api/realtime`,
    providerOptions: { experimental: true, apiKey: 'vda_fake', appId: 'test', appKey: 'fake-private-key',
      httpOrigin: `http://127.0.0.1:${viduHttp.address().port}`, wsOrigin: `ws://127.0.0.1:${viduHttp.address().port}` } })
  browser = await chromium.launch({ channel: process.env.DH_BROWSER_CHANNEL || undefined, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    // Observe scoped vendor metadata without replacing the playback controller.
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          try { const m=JSON.parse(event.data); if(m.type==='vidu.session') window.__avatarId=m.rtc.avatar_user_id; } catch {}
        });
      }
    };
  })
  await page.route('https://g.alicdn.com/**', route => route.fulfill({ contentType: 'application/javascript', body: sdk }))
  await page.goto(host.origin)
  assert.equal(live, 0)
  await page.getByTestId('avatar-connect').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-stage"]').dataset.connection === 'connected')
  assert.equal(live, 0, 'connecting must not allocate a paid live')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'large-avatar.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024),
  })
  await page.getByText('已选择上传图片').waitFor()
  const send = async text => { await page.getByTestId('avatar-input').fill(text); await page.getByTestId('avatar-send').click() }
  for (let i = 1; i <= 3; i++) {
    await send(`reply ${i}`)
    await wait(() => events.some(e => e.responseId === `r${i}` && e.type === 'playback.started'))
    await page.waitForFunction(() => document.querySelector('[data-testid="avatar-video"]').dataset.active === 'true')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.ok(!events.some(e => e.type === 'playback.ended'), 'input done/duration must not fake ARTC completion')
    if (i === 1) {
      await page.getByTestId('avatar-mic').click()
      await wait(() => events.some(e => e.type === 'input_audio_buffer.append'))
      await page.getByTestId('avatar-mic').click()
      assert.ok(!events.some(e => e.responseId === 'r1' && e.type === 'playback.cancelled'))
    }
    await page.getByRole('button', { name: '打断', exact: true }).click()
    await wait(() => events.some(e => e.responseId === `r${i}` && e.type === 'playback.cancelled'))
    await page.waitForFunction(() => window.__rtcEngines.every(e => e.destroyed))
  }
  assert.equal(live, 3)
  await page.evaluate(() => { window.__blockArtcVideo = true })
  await send('blocked video')
  await wait(() => events.some(e => e.responseId === 'r4' && e.type === 'playback.cancelled'))
  await page.waitForFunction(() => window.__rtcEngines.every(e => e.destroyed))
  assert.ok(!events.some(e => e.type === 'playback.ended'))
  await page.getByRole('button', { name: '结束', exact: true }).click()
  await page.getByTestId('avatar-connect').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-stage"]').dataset.connection === 'connected')
  await page.evaluate(() => { window.__blockArtcVideo = false })
  await send('after reconnect')
  await wait(() => events.some(e => e.responseId === 'r5' && e.type === 'playback.started'))
  await page.getByRole('button', { name: '结束', exact: true }).click()
  await page.waitForFunction(() => window.__rtcEngines.every(e => e.destroyed))
  await wait(() => controls.filter(e => e.type === 5).length === live)
  assert.deepEqual(errors, [])
  console.log('PASS Vidu adapter: shared GCP connection, actual MediaStream audio graph, multiple scoped lives, no fake ended receipts, mic mute, local interruption, autoplay rejection, reconnect and cleanup (mock vendor only)')
} finally {
  await browser?.close()
  await host?.close()
  for (const socket of gateway.clients) socket.terminate()
  await new Promise(resolve => gateway.close(resolve))
  upstreams.forEach(socket => socket.terminate())
  await new Promise(resolve => viduWs.close(resolve))
  viduHttp.closeAllConnections()
  await new Promise(resolve => viduHttp.close(resolve))
}
