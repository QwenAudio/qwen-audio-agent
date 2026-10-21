// Hermetic browser smoke: normal GCP mock + REAL example bridge + REAL DHAV
// mock renderer + Chromium Web Audio/canvas. No provider key, no autoplay flag,
// no private Gateway internals and no fake successful playback callbacks.
// Run after build:client: node test/browser-smoke.mjs [--headed]
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer, WebSocket } from 'ws'
import { chromium } from 'playwright'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { startExampleServer } from '../server/server.mjs'

const STAGE = '[data-testid="avatar-stage"]'
const built = fileURLToPath(new URL('../dist/index.html', import.meta.url))
assert.ok(existsSync(built), 'Run npm run build:client before the browser smoke')

function pcmTone(seconds, frequency = 440) {
  const samples = Math.round(seconds * 24000)
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * frequency / 24000) * 6000), index * 2)
  }
  return data.toString('base64')
}

async function until(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await delay(25)
  }
}

const inbound = []
const upstreamDone = new Map()
const rendererEvents = []
const connections = []
let responseNumber = 0
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise(resolve => gateway.once('listening', resolve))
const emit = (socket, event) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event_id: randomUUID(), ...event }))
}
gateway.on('connection', (socket, request) => {
  connections.push({ socket, url: request.url })
  socket.on('message', data => {
    const event = JSON.parse(data.toString())
    inbound.push({ ...event, receivedAt: Date.now() })
    if (event.type === 'session.hello') {
      emit(socket, { type: 'session.ready', request_event_id: event.event_id,
        protocol_version: event.protocol.max, session_id: 'browser-smoke', capabilities: event.capabilities })
      emit(socket, { type: 'voice.ready', inputSampleRate: 16000 })
    }
    if (event.type === 'text.message') {
      const id = `response-${++responseNumber}`
      emit(socket, { type: 'playback.clear', reason: 'new_text_input' })
      emit(socket, { type: 'transcript.final', role: 'user', content: event.text, turnId: id })
      emit(socket, { type: 'response.started', responseId: id })
      emit(socket, { type: 'transcript.final', role: 'assistant', content: `Reply ${responseNumber}`, responseId: id })
      if (event.text !== 'empty response') {
        emit(socket, { type: 'audio.delta', responseId: id, sampleRate: 24000,
          audio: pcmTone(event.text === 'interrupt this long reply' ? 3 : 0.8, 330 + responseNumber * 55) })
      }
      emit(socket, { type: 'audio.done', responseId: id })
      upstreamDone.set(id, Date.now())
      emit(socket, { type: 'response.done', response: { id, status: 'completed' } })
    }
  })
})

let renderer, application, browser
const errors = []
try {
  renderer = await startMockRendererServer({
    host: '127.0.0.1', port: 0,
    log: (name, fields) => rendererEvents.push({ name, ...fields }),
  })
  application = await startExampleServer({
    host: '127.0.0.1', port: 0,
    gatewayUrl: `ws://127.0.0.1:${gateway.address().port}/api/realtime`,
    rendererUrl: renderer.url,
  })
  browser = await chromium.launch({
    channel: process.env.DH_BROWSER_CHANNEL || undefined,
    headless: !process.argv.includes('--headed'),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' })
  page.on('pageerror', error => errors.push(error.message))
  // Observe actual browser buffer scheduling, never replace playback itself.
  await page.addInitScript(() => {
    window.__audioEvidence = []
    const original = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (at, ...rest) {
      const samples = this.buffer?.getChannelData(0)
      const energy = samples?.reduce((sum, value) => sum + value * value, 0) || 0
      window.__audioEvidence.push({ energy, duration: this.buffer?.duration,
        contextState: this.context.state, currentTime: this.context.currentTime, scheduledAt: at })
      return original.call(this, at, ...rest)
    }
  })
  await page.goto(application.origin)
  await page.locator('[data-testid="avatar-connect"]').waitFor()
  await delay(250)
  assert.equal(connections.length, 0, 'No audio session is created before the user gesture')
  assert.equal(inbound.filter(event => event.type.startsWith('playback.')).length, 0)
  assert.deepEqual(await page.evaluate(() => window.__audioEvidence), [])
  await page.locator('[data-testid="avatar-connect"]').click()
  await page.waitForFunction(selector => document.querySelector(selector)?.dataset.connection === 'connected', STAGE)
  assert.equal(connections.length, 1)
  assert.match(connections[0].url, /^\/api\/realtime\?sessionId=/)
  const hello = inbound.find(event => event.type === 'session.hello')
  assert.equal(hello.connection.input_enabled, false)
  assert.equal(hello.connection.output_enabled, true)
  assert.equal('avatarPersonaId' in hello.connection, false, 'No avatar-specific Gateway mode')

  const receipts = id => inbound.filter(event => event.responseId === id && event.type.startsWith('playback.'))
  const send = async text => {
    await page.locator('[data-testid="avatar-input"]').fill(text)
    await page.locator('[data-testid="avatar-send"]').click()
  }
  const finish = async id => {
    await until(() => receipts(id).some(event => event.type === 'playback.ended'), `${id} playback drain`)
    assert.deepEqual(receipts(id).map(event => event.type), ['playback.started', 'playback.ended'])
    assert.ok(receipts(id).find(event => event.type === 'playback.ended').receivedAt - upstreamDone.get(id) > 600,
      'Upstream completion must not stand in for actual media drain')
  }

  for (const [index, text] of ['first reply', 'second reply'].entries()) {
    await send(text)
    const id = `response-${index + 1}`
    await until(() => upstreamDone.has(id), 'upstream response.done')
    assert.equal(receipts(id).some(event => event.type === 'playback.ended'), false)
    await finish(id)
  }
  assert.ok(Number(await page.locator(STAGE).getAttribute('data-frame-count')) >= 10, 'Real paired frames painted')
  assert.deepEqual(await page.locator('[data-testid="avatar-canvas"]').evaluate(canvas => [canvas.width, canvas.height]), [256, 256])
  assert.ok(await page.locator('[data-testid="avatar-canvas"]').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return pixels.some((value, index) => index % 4 !== 3 && value > 40)
  }), 'Canvas contains decoded I420 content, not a CSS placeholder')

  await page.locator('[data-testid="avatar-mic"]').click()
  await until(() => inbound.some(event => event.type === 'input_audio_buffer.append'), 'microphone worklet PCM')
  const microphone = inbound.find(event => event.type === 'input_audio_buffer.append')
  assert.equal(Buffer.from(microphone.audio, 'base64').length, 640, '20 ms mono PCM16 at 16 kHz')
  await page.locator('[data-testid="avatar-mic"]').click()
  await until(() => inbound.some(event => event.type === 'input.mute'), 'input-only mute')
  assert.equal(inbound.some(event => event.type === 'mute'), false, 'Mic mute must never mute output')

  await send('interrupt this long reply')
  await until(() => receipts('response-3').some(event => event.type === 'playback.started'), 'third response started')
  await send('replacement after interruption')
  await until(() => receipts('response-3').some(event => event.type === 'playback.cancelled'), 'interrupted playback cancelled')
  await finish('response-4')
  assert.deepEqual(receipts('response-3').map(event => event.type), ['playback.started', 'playback.cancelled'])
  assert.ok(rendererEvents.some(event => event.name === 'turn.cancelled'), 'Cancellation reaches real renderer')

  // Late old response chunks cannot resurrect interrupted media or receipts.
  emit(connections[0].socket, { type: 'audio.delta', responseId: 'response-3', sampleRate: 24000, audio: pcmTone(0.2) })
  emit(connections[0].socket, { type: 'audio.done', responseId: 'response-3' })
  emit(connections[0].socket, { type: 'response.done', response: { id: 'response-3', status: 'completed' } })
  await delay(300)
  assert.deepEqual(receipts('response-3').map(event => event.type), ['playback.started', 'playback.cancelled'])

  await send('empty response')
  await until(() => upstreamDone.has('response-5'), 'empty response.done')
  await delay(350)
  assert.equal(receipts('response-5').some(event => ['playback.started', 'playback.ended'].includes(event.type)), false,
    'No audio or empty/silent placeholders can counterfeit delivery receipts')
  const evidence = await page.evaluate(() => window.__audioEvidence)
  assert.ok(evidence.length >= 40)
  assert.ok(evidence.every(item => item.contextState === 'running' && item.energy > 0), 'Every playback source contains actual non-silent PCM')
  const result = { ok: true, completed: ['response-1', 'response-2', 'response-4'],
    cancelled: 'response-3', paintedFrames: Number(await page.locator(STAGE).getAttribute('data-frame-count')),
    realAudioSources: evidence.length, microphoneBytes: 640 }
  await page.close()

  // Exercise real bridge closure, not just the controller in isolation. A
  // renderer loss may fall back only before playback commits; it must not tear
  // down the healthy Gateway connection or replay a partially heard response.
  for (const fault of ['first_media_timeout', 'channel_drop']) {
    await application.close()
    await renderer.close()
    renderer = await startMockRendererServer({ host: '127.0.0.1', port: 0, fault })
    application = await startExampleServer({
      host: '127.0.0.1', port: 0,
      gatewayUrl: `ws://127.0.0.1:${gateway.address().port}/api/realtime`, rendererUrl: renderer.url,
      providerOptions: { firstMediaTimeoutMs: 250 },
    })
    const faultPage = await browser.newPage()
    faultPage.on('pageerror', error => errors.push(error.message))
    await faultPage.goto(application.origin)
    await faultPage.locator('[data-testid="avatar-connect"]').click()
    await faultPage.waitForFunction(selector => document.querySelector(selector)?.dataset.connection === 'connected', STAGE)
    const id = `response-${responseNumber + 1}`
    await faultPage.locator('[data-testid="avatar-input"]').fill(`fault ${fault}`)
    await faultPage.locator('[data-testid="avatar-send"]').click()
    if (fault === 'first_media_timeout') {
      await finish(id)
      assert.equal(Number(await faultPage.locator(STAGE).getAttribute('data-frame-count')), 0, 'Precommit fallback is original audio only')
    } else {
      await until(() => receipts(id).some(event => event.type === 'playback.cancelled'), 'postcommit renderer disconnect cancellation')
      await delay(900)
      assert.deepEqual(receipts(id).map(event => event.type), ['playback.started', 'playback.cancelled'],
        'A partially heard renderer response must not restart as original audio')
    }
    assert.equal(await faultPage.locator(STAGE).getAttribute('data-connection'), 'connected', 'Renderer loss must preserve Gateway')
    assert.equal(await faultPage.locator('[data-testid="avatar-connect"]').isEnabled(), true, 'Explicit renderer reconnect remains available')
    // Future responses can still finish through original audio on the same GCP.
    const nextId = `response-${responseNumber + 1}`
    await faultPage.locator('[data-testid="avatar-input"]').fill('audio after renderer loss')
    await faultPage.locator('[data-testid="avatar-send"]').click()
    await finish(nextId)
    const connectionCount = connections.length
    await faultPage.locator('[data-testid="avatar-connect"]').click()
    await until(() => connections.length > connectionCount, 'explicit dual connection reconnect')
    await faultPage.waitForFunction(selector => document.querySelector(selector)?.dataset.connection === 'connected', STAGE)
    assert.equal(await faultPage.locator(STAGE).getAttribute('data-frame-count'), '0', 'Reconnect resets stale presentation')
    await faultPage.close()
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ...result, faults: ['first_media_timeout', 'channel_drop'], reconnect: true }))
} catch (error) {
  console.error('Browser errors:', errors)
  console.error('Gateway events:', inbound.map(event => ({ type: event.type, responseId: event.responseId })))
  console.error('Renderer events:', rendererEvents)
  throw error
} finally {
  await browser?.close()
  await application?.close()
  await renderer?.close()
  for (const client of gateway.clients) client.terminate()
  await new Promise(resolve => gateway.close(resolve))
}
