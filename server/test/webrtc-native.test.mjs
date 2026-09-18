import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { encodePcm, decodePcm } from '../src/transport/webrtc/pcm.mjs'
import { rtcHarness, waitUntil } from './fixtures/webrtc-gateway.mjs'

const enabled = process.env.QWAUDIO_TEST_WEBRTC_NATIVE === '1'
async function browserFor(t, base) {
  const { chromium } = await import(process.env.QWAUDIO_TEST_PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.QWAUDIO_TEST_PLAYWRIGHT_MODULE).href : 'playwright')
  const browser = await chromium.launch({ headless: true, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  ] })
  t.after(() => browser.close())
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: 'Bearer test-only-credential' } })
  await context.grantPermissions(['microphone', 'camera'], { origin: base })
  await context.addInitScript(() => {
    window.testPeers = []
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(Target, args) {
        const peer = new Target(...args)
        window.testPeers.push(peer)
        return peer
      },
    })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/api/realtime/webrtc/example`)
  return { page, errors }
}

async function connect(page, video = false) {
  await page.locator('#camera').setChecked(video)
  await page.locator('#connect').click()
  await page.waitForFunction(() => document.getElementById('status').textContent === '可以说话了', null, { timeout: 15000 })
}

for (const video of [false, true]) {
  test(`browser WebRTC ${video ? 'Omni' : 'Audio'}: repeated media, history and clean worker exit`, { skip: !enabled, timeout: 90000 }, async t => {
    const h = await rtcHarness(t, { video, realMedia: true })
    const { page, errors } = await browserFor(t, h.base)
    for (let cycle = 0; cycle < 3; cycle++) {
      await connect(page, video)
      const frontend = h.frontends.at(-1)
      await waitUntil(() => frontend.audio.some(audio => decodePcm(audio).some(value => Math.abs(value) > 100)), 10000)
      if (video) {
        await waitUntil(() => frontend.images.length > 0, 6000)
        assert.equal(Buffer.from(frontend.images[0], 'base64').readUInt16BE(0), 0xffd8)
      }
      if (cycle > 0) assert.ok(frontend.agentContext.recentMessages.some(message => message.content === `Browser test ${cycle - 1}`))
      await page.locator('#text').fill(`Browser test ${cycle}`)
      await page.locator('#send').click()
      await waitUntil(() => frontend.inputs.length === 1)
      const responseId = `browser-reply-${cycle}`
      const output = Int16Array.from({ length: 24000 }, (_, index) => Math.round(6000 * Math.sin(index * 2 * Math.PI * 440 / 24000)))
      frontend.emit({ type: 'response.created', response: { id: responseId }, __voiceContext: frontend.inputs[0].context })
      frontend.emit({ type: 'response.audio.delta', response_id: responseId, delta: encodePcm(output) })
      frontend.emit({ type: 'response.audio_transcript.done', response_id: responseId, transcript: `Synthetic reply ${cycle}` })
      frontend.emit({ type: 'response.done', response: { id: responseId, status: 'completed' } })
      await page.waitForFunction(async () => {
        const stats = await window.testPeers.at(-1).getStats()
        return [...stats.values()].some(report => report.type === 'inbound-rtp' && report.kind === 'audio' && report.totalAudioEnergy > 0)
      }, null, { timeout: 8000 })
      await page.waitForFunction(text => document.getElementById('log').textContent.includes(text), `Synthetic reply ${cycle}`, { timeout: 8000 })
      await page.locator('#interrupt').click()
      await page.waitForFunction(() => document.getElementById('log').textContent.includes('output_audio_buffer.cleared'))
      const media = h.media.at(-1)
      await page.locator('#disconnect').click()
      const exit = await media.whenClosed()
      assert.deepEqual(exit, { code: 0, signal: null, graceful: true, acknowledged: true, forced: false })
      await waitUntil(() => h.ingress.status().retiring === 0)
      assert.equal(h.ingress.status().connections, 0)
      await page.locator('#connect').waitFor({ state: 'visible' })
    }
    assert.deepEqual(errors, [])
  })
}

test('media crash is isolated from WSS and a new WebRTC connection still works', { skip: !enabled, timeout: 45000 }, async t => {
  const h = await rtcHarness(t, { realMedia: true })
  const { page } = await browserFor(t, h.base)
  const ws = new WebSocket(h.base.replace('http:', 'ws:') + '/api/realtime', {
    headers: { Authorization: 'Bearer test-only-credential', 'x-test-owner': 'wss-unaffected-owner' },
  })
  t.after(() => ws.close())
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'connect', clientType: 'test', textOnly: true, inputEnabled: false, outputEnabled: false }))
  await connect(page)
  const crashed = h.media.at(-1)
  crashed.child.kill('SIGKILL')
  const exit = await crashed.whenClosed()
  assert.equal(exit.graceful, false)
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(ws.readyState, WebSocket.OPEN)
  const pong = once(ws, 'pong')
  ws.ping()
  await pong
  assert.equal((await fetch(h.base + '/api/v1/webrtc/config', { headers: h.headers })).status, 200)
  await page.reload()
  await connect(page)
  const replacement = h.media.at(-1)
  assert.notEqual(replacement, crashed)
  await page.locator('#disconnect').click()
  assert.equal((await replacement.whenClosed()).graceful, true)
})
