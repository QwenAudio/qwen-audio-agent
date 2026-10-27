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
let reply = 0, live = 0, receivedPcm = 0
const monitors = new Set()
const sourcePcm = () => { const b = Buffer.alloc(24000 * 2 * 2); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i * 0.07) * Math.sin(i * i * 0.0000017)), i * 2); return b }
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
    emit(socket, { type: 'audio.delta', responseId, sampleRate: 24000, audio: sourcePcm().toString('base64') })
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
viduWs.on('connection', (socket, request) => {
  if (request.url === '/monitor') { monitors.add(socket); socket.once('close', () => monitors.delete(socket)); return }
  upstreams.push(socket)
  socket.on('message', (raw, binary) => {
    if (binary) { receivedPcm++; for (const monitor of monitors) monitor.send(raw); return }
    const event = JSON.parse(raw); controls.push(event)
    if (event.type === 7) { for (const monitor of monitors) monitor.send('clear') }
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
    const queue = []; let sample = 0;
    const monitor = new WebSocket('ws://127.0.0.1:${viduHttp.address().port}/monitor'); monitor.binaryType='arraybuffer';
    monitor.onmessage = ({data}) => { if(data==='clear'){queue.length=0;sample=0;return} const view=new DataView(data), values=[];for(let i=0;i<view.byteLength;i+=2)values.push(view.getInt16(i,true)/32768);queue.push(window.__unmatchedRemote ? values.map(()=>0.1) : values) };
    const processor=context.createScriptProcessor(1024,0,1);
    processor.onaudioprocess=e=>{const out=e.outputBuffer.getChannelData(0);for(let i=0;i<out.length;i++){out[i]=queue.length?queue[0][Math.floor(sample)]||0:0;if(queue.length){sample+=24000/context.sampleRate;if(sample>=queue[0].length){sample-=queue[0].length;queue.shift()}}}};
    processor.connect(destination);
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
    canvas.getContext('2d').fillRect(0,0,40,40);
    const videoStream = canvas.captureStream(25); const handlers = {};
    const engine = {
      volume: 0, destroyed: false,
      on: (name,fn) => {handlers[name]=fn},
      setPlayoutVolume(volume) { this.volume=volume },
      getAudioTrack: async () => destination.stream.getAudioTracks()[0],
      async getVideoTrack() {
        const video = document.querySelector('[data-testid="avatar-video"]');
        video.play = window.__blockArtcVideo ? () => Promise.reject(new Error('blocked')) : HTMLMediaElement.prototype.play.bind(video);
        return videoStream.getVideoTracks()[0];
      },
      setChannelProfile(){}, publishLocalAudioStream(){}, publishLocalVideoStream(){}, enableLocalVideo(){},
      setDefaultSubscribeAllRemoteAudioStreams(){}, setDefaultSubscribeAllRemoteVideoStreams(){},
      async joinChannel() { await new Promise(resolve => { if(monitor.readyState===1)resolve();else monitor.addEventListener('open',resolve,{once:true}) }); handlers.audioSubscribeStateChanged(''+window.__avatarId,0,3); handlers.videoSubscribeStateChanged(''+window.__avatarId,0,3); },
      async leaveChannel(){}, async destroy() {
        this.destroyed=true; processor.disconnect(); monitor.close(); videoStream.getTracks().forEach(t=>t.stop());
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
    window.__sourceBuffers = []; window.__sourceGains = [];
    const gain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function(...args) {
      const node = gain.apply(this,args); window.__sourceGains.push(node); return node;
    };
    const source = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function(...args) {
      const node = source.apply(this,args); window.__sourceBuffers.push(node); return node;
    };
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
  await page.route('https://scene.vidu.zone/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="16"><rect width="12" height="16" fill="green"/></svg>' }))
  await page.goto(host.origin)
  await page.getByTestId('avatar-reference').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-reference"]').naturalWidth > 0)
  assert.match(await page.getByTestId('avatar-reference').getAttribute('src'), /vidu-default-preview/)
  assert.equal(live, 0)
  await page.getByTestId('avatar-connect').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-stage"]').dataset.connection === 'connected')
  await wait(() => live === 1)
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-video"]').dataset.active === 'true')
  await wait(() => events.some(e => e.type === 'input_audio_buffer.append'))
  await page.getByRole('button', { name: '麦克风静音', exact: true }).waitFor()
  const send = async text => { await page.getByTestId('avatar-input').fill(text); await page.getByTestId('avatar-send').click() }
  assert.ok(!events.find(e => e.type === 'session.hello').capabilities.includes('playback.receipts'))
  await page.evaluate(() => { window.__unmatchedRemote = true })
  await send('native audio and video')
  await wait(() => receivedPcm > 0)
  assert.equal(await page.evaluate(() => window.__sourceBuffers.length), 0, 'no hidden source playback clock')
  const firstStream = await page.evaluateHandle(() => document.querySelector('[data-testid="avatar-video"]').srcObject)
  await page.getByTestId('avatar-mic').click()
  await page.getByRole('button', { name: '开启麦克风', exact: true }).waitFor()
  assert.equal(await page.evaluate(stream => {
    const v = document.querySelector('[data-testid="avatar-video"]')
    return v.srcObject === stream && !v.muted && !v.paused
  }, firstStream), true, 'microphone mute must not stop output')
  await page.getByTestId('avatar-mic').click()
  await page.getByRole('button', { name: '麦克风静音', exact: true }).waitFor()
  await send('new input cancels old media')
  await wait(() => live === 2)
  await page.waitForFunction(() => window.__rtcEngines.length === 2 && window.__rtcEngines[0].destroyed)
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-video"]').dataset.active === 'true')
  assert.equal(await page.evaluate(stream => document.querySelector('[data-testid="avatar-video"]').srcObject !== stream, firstStream), true)
  assert.equal(controls.filter(e => e.type === 7).length, 1)
  await page.getByRole('button', { name: '打断', exact: true }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="avatar-video"]')
    return v.muted && v.paused && v.srcObject === null
  })
  await wait(() => controls.filter(e => e.type === 7).length === 2)
  assert.equal(live, 2, 'cancellation alone must not allocate a replacement paid live')
  await send('next response creates a fresh channel')
  await wait(() => live === 3)
  await page.waitForFunction(() => window.__rtcEngines.length === 3 && window.__rtcEngines.slice(0,2).every(e => e.destroyed))
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-video"]').dataset.active === 'true')
  assert.ok(!events.some(e => ['playback.started', 'playback.ended', 'playback.cancelled'].includes(e.type)), 'native RTC has no proven response receipts')
  upstreams.at(-1).close()
  await page.getByTestId('avatar-error').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-stage"]').dataset.connection === 'error')
  assert.equal(await page.getByTestId('avatar-mic').isDisabled(), true)
  await page.waitForFunction(() => window.__rtcEngines.every(e => e.destroyed))
  await page.getByTestId('avatar-connect').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-stage"]').dataset.connection === 'connected')
  await wait(() => live === 4)
  await page.waitForFunction(() => window.__rtcEngines.length === 4)
  await send('after explicit reconnect')
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar-video"]').dataset.active === 'true')
  await page.getByRole('button', { name: '结束', exact: true }).click()
  await page.waitForFunction(() => window.__rtcEngines.every(e => e.destroyed))
  // Two cancellations and explicit close hang up; the injected remote failure
  // already closed the third live's socket and cannot receive a hangup packet.
  await wait(() => controls.filter(e => e.type === 5).length === 3)
  await wait(() => upstreams.every(socket => socket.readyState === WebSocket.CLOSED))
  assert.ok(!events.some(e => ['playback.started', 'playback.ended', 'playback.cancelled'].includes(e.type)))
  // The Electron shell uses the same page with a full-window portrait and
  // optional drawers. Exercise that presentation without a paid service.
  await page.addInitScript(() => { window.viduAvatarDesktop = { quit() {} } })
  await page.setViewportSize({ width: 390, height: 620 })
  await page.reload()
  await page.getByTestId('avatar-reference').waitFor({ state: 'visible' })
  const stage = await page.locator('.avatar-viewport').boundingBox()
  assert.deepEqual(stage, { x: 0, y: 0, width: 390, height: 620 })
  assert.equal(await page.locator('.renderer-settings').isVisible(), false)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('角色图片 HTTPS URL').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await page.getByTestId('avatar-input').waitFor({ state: 'visible' })
  assert.deepEqual(errors, [])
  console.log('PASS Vidu adapter: native audio/video, no fabricated receipts, immediate local stop, remote interrupt/hangup, fresh live on next response, microphone-only mute, fail-closed errors and reconnect (mock vendor only)')
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
