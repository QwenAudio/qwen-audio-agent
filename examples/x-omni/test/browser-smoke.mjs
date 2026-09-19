import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { WebSocketServer } from 'ws'

// Full browser -> GCP -> tool source -> Client Action -> independent reader
// -> tool result -> main Realtime response. No key, hardware, or cloud calls.
const directory = mkdtempSync(join(tmpdir(), 'xomni-browser-'))
const miniCpm = process.argv.includes('--minicpm')
const webRtc = process.argv.includes('--webrtc')
const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(upstream, 'listening')
Object.assign(process.env, {
  DASHSCOPE_API_KEY: miniCpm ? '' : 'fixture-only',
  QWEN_AUDIO_REALTIME_PROVIDER: miniCpm ? 'minicpm-o' : 'dashscope',
  MINICPM_O_REALTIME_URL: `ws://127.0.0.1:${upstream.address().port}/v1/realtime?mode=video`,
  QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
  QWEN_AUDIO_REALTIME_BASE_URL: `ws://127.0.0.1:${upstream.address().port}/realtime`,
  QWAUDIO_CONFIG_DIR: directory, QWAUDIO_DATA_DIR: join(directory, 'data'),
  QWAUDIO_STATE_DIR: join(directory, 'state'), QWAUDIO_CACHE_DIR: join(directory, 'cache'),
  AGENT_PROTOCOL: 'none', QWEN_AUDIO_GATEWAY_ACCESS_TOKEN: '',
  QWEN_AUDIO_GATEWAY_ACCESS_KEYS: '', QWEN_AUDIO_GATEWAY_TAILNET: '0',
})
let readerImages = 0
let continuousImages = 0
let result
let sequence = 0
let latestText = ''
let observationReads = 0
const wireEvents = []
upstream.on('connection', socket => {
  let reader = false
  let structured = false
  let hasResult = false
  const send = event => socket.send(JSON.stringify(event))
  send(miniCpm ? { type: 'session.queue_done', session_id: 'fixture' }
    : { type: 'session.created', session: { id: 'fixture' } })
  socket.on('message', raw => {
    const event = JSON.parse(raw)
    wireEvents.push(`${reader ? 'reader' : 'main'}:${event.type}`)
    if (event.type === 'session.init') {
      assert.ok(miniCpm)
      send({ type: 'session.created', session_id: 'fixture', mode: 'video' })
    } else if (event.type === 'input.append' && event.input.video_frames?.length) {
      assert.ok(miniCpm)
      assert.ok(event.input.audio, 'MiniCPM frames must accompany audio')
      continuousImages += event.input.video_frames.length
      send({ type: 'response.done', response_id: `minicpm-${++sequence}`, text: '已读取持续画面。' })
    } else if (event.type === 'session.update') {
      reader = event.session.modalities?.length === 1
      structured = reader && event.session.instructions.includes('Return only JSON')
      send({ type: 'session.updated', session: { id: 'fixture', ...event.session } })
    } else if (event.type === 'input_image_buffer.append') {
      if (reader) readerImages++
      else continuousImages++
    } else if (event.type === 'input_audio_buffer.commit') {
      send({ type: 'input_audio_buffer.committed', item_id: 'fixture-image' })
    } else if (event.type === 'conversation.item.create') {
      send({ type: 'conversation.item.created', item: event.item })
      if (event.item.type === 'function_call_output') {
        result = JSON.parse(event.item.output)
        hasResult = true
      } else if (event.item.role === 'user') {
        latestText = (event.item.content || []).map(part => part.text || '').join('')
        hasResult = false
      }
    } else if (event.type === 'response.create') {
      const id = `fixture-response-${++sequence}`
      send({ type: 'response.created', response: { id } })
      if (reader || hasResult) {
        if (structured) observationReads++
        const text = reader
          ? structured ? '{"match":false,"summary":"Still watching the synthetic image."}' : 'The image contains a colorful test pattern.'
          : result?.status === 'started' ? '已开始观察。' : '已读取当前画面：彩色测试图。'
        if (!reader && webRtc) {
          const samples = Buffer.alloc(24000)
          for (let i = 0; i < samples.length / 2; i++) samples.writeInt16LE(Math.round(6000 * Math.sin(i * 2 * Math.PI * 440 / 24000)), i * 2)
          send({ type: 'response.audio.delta', response_id: id, delta: samples.toString('base64') })
          send({ type: 'response.audio.done', response_id: id })
        }
        send({ type: 'response.text.done', response_id: id, text })
        send({ type: 'response.done', response: { id, status: 'completed', output: [] } })
      } else {
        const observation = latestText.includes('Start observation')
        const item = { type: 'function_call', call_id: `capture-call-${sequence}`, name: observation ? 'visual_observation' : 'capture_visual',
          arguments: observation ? '{"operation":"start","focus":"Watch the synthetic image","mode":"condition","duration_seconds":60}' : '{"question":"Describe the selected image"}' }
        send({ ...item, type: 'response.function_call_arguments.done', response_id: id })
        send({ type: 'response.done', response: { id, status: 'completed', output: [item] } })
      }
    }
  })
})
let gateway, vite, browser
try {
  const { startXOmni } = await import('../gateway.mjs')
  gateway = await startXOmni({ port: 0, envFile: null, transport: webRtc ? 'webrtc' : 'websocket' })
  vite = await createServer({
    mode: webRtc ? 'webrtc' : 'websocket',
    configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
    server: { port: 0, strictPort: false, hmr: false, proxy: { '/api': {
      target: `http://127.0.0.1:${gateway.server.address().port}`, ws: true,
    } } },
  })
  await vite.listen()
  browser = await chromium.launch({ headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1320, height: 920 } })
  await page.addInitScript(() => {
    window.testPeers = []
    window.sentRtcEvents = []
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(Target, args) {
        const peer = new Target(...args)
        window.testPeers.push(peer)
        peer.addEventListener('datachannel', ({ channel }) => {
          const send = channel.send.bind(channel)
          channel.send = raw => { window.sentRtcEvents.push(JSON.parse(raw)); send(raw) }
        })
        return peer
      },
    })
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(vite.resolvedUrls.local[0])
  await page.getByText(/^connected ·/).waitFor({ timeout: 15_000 }).catch(async error => {
    throw new Error(error.message + '\n' + await page.locator('body').innerText() + '\n' + JSON.stringify(errors))
  })
  await page.getByRole('button', { name: '摄像头', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  assert.equal(readerImages + continuousImages, 0, 'on-demand preview must not send frames')
  if (miniCpm) {
    assert.equal(await page.getByRole('button', { name: '按需采集', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('textbox', { name: '消息' }).isDisabled(), true)
    assert.equal(await page.locator('summary').count(), 0)
    await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await page.getByText('已读取持续画面。', { exact: true }).first().waitFor({ timeout: 20_000 })
    await assertEventually(() => continuousImages > 0)
    assert.equal(readerImages, 0, 'MiniCPM must not create DashScope reader requests')
    assert.equal(wireEvents.some(value => /session.update|response.create|conversation.item.create/.test(value)), false)
  } else {
    await page.getByRole('textbox', { name: '消息' }).fill('Describe the current image')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('已读取当前画面：彩色测试图。', { exact: true }).waitFor({ timeout: 20_000 }).catch(async error => {
      throw new Error(error.message + JSON.stringify({ readerImages, continuousImages, result, wireEvents })
        + '\n' + await page.locator('body').innerText())
    })
    assert.equal(readerImages, 1)
    assert.equal(continuousImages, 0)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.input_refs, ['input_1'])
    if (webRtc) await page.waitForFunction(() => window.sentRtcEvents.some(event => event.type === 'qwaudio.playback.ended'), null, { timeout: 10000 })
    await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
    await page.getByRole('button', { name: '持续画面', exact: true }).click()
    await page.waitForFunction(() => /已发送 [1-9]/.test(document.body.textContent))
    await assertEventually(() => continuousImages > 0)
    await page.getByRole('button', { name: '关闭来源', exact: true }).click()
    await page.getByText('先选择来源并授权。尚未采集或发送任何画面。').waitFor()
    await page.getByRole('button', { name: '按需采集', exact: true }).click()
    if (webRtc) {
      await page.getByRole('button', { name: '静音麦克风', exact: true }).click()
      await page.waitForFunction(() => window.testPeers.at(-1).getSenders().filter(sender => sender.track?.kind === 'audio').every(sender => !sender.track.enabled))
      assert.equal(await page.evaluate(() => window.testPeers.at(-1).connectionState), 'connected', 'mute must retain the connection')
      await page.waitForFunction(() => window.testPeers.at(-1).getSenders().every(sender => sender.track?.kind !== 'video'))
    }
    const beforeUpload = readerImages + continuousImages
    const fixture = await page.screenshot({ type: 'png' })
    await page.locator('input[type=file]').setInputFiles({
      name: 'fixture.png', mimeType: 'image/png', buffer: fixture,
    })
    await page.getByAltText('用户选择的图片').waitFor()
    assert.equal(readerImages + continuousImages, beforeUpload, 'image preview must remain local')
    if (webRtc) {
      // An incompressible image exercises real SCTP fragmentation, not only a
      // tiny synthetic camera frame. Capture encoding still enforces 190 KiB.
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 1024; canvas.height = 768
        const context = canvas.getContext('2d')
        const pixels = context.createImageData(1024, 768)
        let seed = 7
        for (let i = 0; i < pixels.data.length; i++) {
          seed = (1664525 * seed + 1013904223) >>> 0
          pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24
        }
        context.putImageData(pixels, 0, 0)
        return canvas.toDataURL('image/png').split(',')[1]
      })
      await page.locator('input[type=file]').setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
      await page.getByRole('textbox', { name: '消息' }).fill('Describe the noise image')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await assertEventually(() => readerImages === 2)
      await page.waitForFunction(() => window.sentRtcEvents.filter(event => event.type === 'qwaudio.transport.chunk').length > 8)
      await assertEventually(() => result?.input_refs?.[0] === 'input_2')
      await page.getByRole('textbox', { name: '消息' }).fill('Start observation')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await assertEventually(() => observationReads > 0)
      assert.equal(result.status, 'started')
      await page.getByRole('button', { name: '关闭来源', exact: true }).click()
      await page.waitForTimeout(11000)
      assert.equal(observationReads, 1, 'closing the source cancels subsequent observations')
      const peerCount = await page.evaluate(() => window.testPeers.length)
      await page.evaluate(() => window.testPeers.at(-1).close())
      await page.getByRole('button', { name: '重新连接', exact: true }).click()
      await page.getByText(/^connected ·/).waitFor({ timeout: 15000 })
      assert.equal(await page.evaluate(() => window.testPeers.length), peerCount + 1)
    }
  }
  await page.getByRole('button', { name: '关闭来源', exact: true }).click()
  if (process.env.X_OMNI_SCREENSHOT) await page.screenshot({ path: process.env.X_OMNI_SCREENSHOT, fullPage: true })
  assert.deepEqual(errors, [])
  console.log(`X-Omni browser smoke passed (${webRtc ? 'WebRTC' : 'WebSocket'} / ${miniCpm ? 'MiniCPM-o video' : 'Qwen Omni visual tools'}).`)
} catch (error) {
  console.error(error, { readerImages, continuousImages, wireEvents })
  throw error
} finally {
  await browser?.close()
  await vite?.close()
  await gateway?.close()
  for (const socket of upstream.clients) socket.terminate()
  await new Promise(resolve => upstream.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}

async function assertEventually(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected media did not arrive')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
