import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const projectRoot = resolve(import.meta.dirname, '../..')
const webRoot = resolve(projectRoot, 'web')
const DEFAULT_PORT = 4174
const configuredPort = process.env.QWEN_BROWSER_SMOKE_PORT || String(DEFAULT_PORT)
const port = Number(configuredPort)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`QWEN_BROWSER_SMOKE_PORT must be an integer from 1 to 65535 (received ${configuredPort})`)
}
const baseUrl = `http://127.0.0.1:${port}`

// Keep the browser test deterministic and offline: the page gets a local
// protocol/media double, while Chromium still exercises the real React page,
// permission branch, Web Audio wiring, and cleanup lifecycle.
const MOCK_BROWSER_APIS = String.raw`
(() => {
  const state = {
    mediaRequests: 0,
    trackStops: 0,
    audioContexts: 0,
    audioCloses: 0,
    sourceConnects: 0,
    sourceDisconnects: 0,
    processorConnects: 0,
    processorDisconnects: 0,
    audioAppends: 0,
    playbackStarts: 0,
    playbackStops: 0,
    socketMessages: 0,
    socketConnections: 0,
    socketCloses: 0,
    sessionReadyEvents: 0,
    nextEvent: 1,
    processor: null,
    activeSocket: null,
    oldSocket: null,
  }

  const update = (name, value) => {
    state[name] = value
    document.documentElement.dataset[name] = String(value)
  }
  const increment = name => update(name, state[name] + 1)
  const eventListeners = target => {
    target.listeners = new Map()
    target.addEventListener = (name, listener) => {
      const listeners = target.listeners.get(name) || []
      listeners.push(listener)
      target.listeners.set(name, listeners)
    }
    target.removeEventListener = (name, listener) => {
      target.listeners.set(
        name,
        (target.listeners.get(name) || []).filter(item => item !== listener),
      )
    }
    target.emit = (name, value) => {
      for (const listener of target.listeners.get(name) || []) listener(value)
    }
    return target
  }

  const serverEvent = (socket, event) => {
    if (socket.readyState !== MockWebSocket.OPEN) return
    socket.emit('message', {
      data: JSON.stringify({
        event_id: 'mock-server-' + state.nextEvent++,
        ...event,
      }),
    })
  }

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor(url) {
      this.url = url
      this.readyState = MockWebSocket.CONNECTING
      eventListeners(this)
      increment('socketConnections')
      this.id = state.socketConnections
      setTimeout(() => {
        if (this.readyState !== MockWebSocket.CONNECTING) return
        this.readyState = MockWebSocket.OPEN
        state.activeSocket = this
        this.emit('open')
      }, 0)
    }

    send(raw) {
      const message = JSON.parse(raw)
      state.socketMessages += 1
      document.documentElement.dataset.lastSocketMessage = message.type
      if (message.type === 'session.hello') {
        setTimeout(() => {
          if (this.readyState !== MockWebSocket.OPEN) return
          increment('sessionReadyEvents')
          serverEvent(this, {
            type: 'session.ready',
            request_event_id: message.event_id,
            protocol_version: '6.0.0',
            session_id: 'browser-smoke',
            capabilities: ['session.heartbeat'],
          })
          this.handshakeReady = true
          serverEvent(this, { type: 'session.ping', event_id: 'ping-' + this.id })
        }, 0)
        setTimeout(() => serverEvent(this, {
          type: 'voice.ready',
          inputSampleRate: 16_000,
          provider: 'browser-smoke',
        }), 0)
      }
      if (message.type === 'audio.append') {
        increment('audioAppends')
        document.documentElement.dataset.audioSocket = String(this.id)
        setTimeout(() => {
          const responseId = 'response-browser-smoke-' + this.id
          serverEvent(this, {
            type: 'response.started',
            responseId,
          })
          serverEvent(this, {
            type: 'audio.delta',
            audio: 'AAAAAA==',
            sampleRate: 24_000,
            responseId,
          })
          serverEvent(this, {
            type: 'audio.done',
            responseId,
          })
          serverEvent(this, { type: 'transcript.final', role: 'assistant',
            responseId, content: 'Reply from connection ' + this.id })
        }, 0)
      }
      if (message.type === 'playback.started') {
        document.documentElement.dataset.playbackResponse = message.responseId
      }
      if (message.type === 'session.pong' && message.request_event_id === 'ping-' + this.id) {
        document.documentElement.dataset.negotiatedSocket = String(this.id)
      }
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) return
      this.readyState = MockWebSocket.CLOSED
      increment('socketCloses')
      this.emit('close', { code: 1000 })
    }
  }

  class MockAudioContext {
    constructor() {
      increment('audioContexts')
      this.state = 'suspended'
      this.currentTime = 0
      this.sampleRate = 48_000
      this.destination = {}
    }

    resume() {
      this.state = 'running'
      return Promise.resolve()
    }

    close() {
      increment('audioCloses')
      this.state = 'closed'
      return Promise.resolve()
    }

    createMediaStreamSource() {
      return {
        connect() { increment('sourceConnects') },
        disconnect() { increment('sourceDisconnects') },
      }
    }

    createScriptProcessor() {
      const processor = {
        onaudioprocess: null,
        connected: false,
        connect() {
          if (processor.connected) return
          processor.connected = true
          increment('processorConnects')
          state.processor = processor
          setTimeout(() => processor.onaudioprocess?.({
            inputBuffer: {
              getChannelData: () => Float32Array.from([0.1, 0.2, 0.3, 0.4]),
            },
          }), 0)
        },
        disconnect() {
          processor.connected = false
          increment('processorDisconnects')
        },
      }
      return processor
    }

    createBuffer(_channels, length, sampleRate) {
      return {
        duration: length / sampleRate,
        copyToChannel() {},
      }
    }

    createBufferSource() {
      const source = {
        onended: null,
        connect() {},
        start() {
          increment('playbackStarts')
          if (!location.search.includes('browser-smoke=reconnect')) {
            setTimeout(() => source.onended?.(), 40)
          }
        },
        stop() {
          increment('playbackStops')
        },
      }
      return source
    }
  }

  let trackNumber = 0
  const mediaDevices = eventListeners({
    async getUserMedia() {
      increment('mediaRequests')
      if (location.search.includes('deny-microphone')) {
        const error = new Error('Permission denied')
        error.name = 'NotAllowedError'
        throw error
      }
      trackNumber += 1
      const track = eventListeners({
        muted: false,
        stop() { increment('trackStops') },
      })
      if (location.search.includes('browser-smoke=track-ended') && trackNumber === 1) {
        setTimeout(() => track.emit('ended'), 10)
      }
      return {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      }
    },
  })

  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    })
  } catch {
    navigator.mediaDevices.getUserMedia = mediaDevices.getUserMedia
  }
  window.WebSocket = MockWebSocket
  window.AudioContext = MockAudioContext
  window.webkitAudioContext = MockAudioContext
  window.browserSmoke = {
    connection: () => ({ id: state.activeSocket?.id, ready: state.activeSocket?.handshakeReady }),
    disconnect() { state.oldSocket = state.activeSocket; state.oldSocket.close() },
    input() {
      if (state.processor?.connected) state.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => Float32Array.from([0.4, 0.3, 0.2, 0.1]) },
      })
    },
    stale() {
      // Deliberately bypass the mock transport guard to exercise the SDK's guard.
      state.oldSocket.emit('message', { data: JSON.stringify({
        type: 'transcript.final', event_id: 'stale-event', role: 'assistant',
        responseId: 'stale-response', content: 'STALE CONNECTION REPLY',
      }) })
    },
  }
})()
`

function startVite() {
  const vite = spawn(
    process.execPath,
    [resolve(projectRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let spawnError = null
  vite.stdout.on('data', chunk => { output += chunk.toString() })
  vite.stderr.on('data', chunk => { output += chunk.toString() })
  vite.once('error', error => { spawnError = error })
  return {
    vite,
    getOutput: () => output,
    getSpawnError: () => spawnError,
  }
}

async function waitForServer({ vite, getOutput, getSpawnError }) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getSpawnError()) {
      throw new Error(`Unable to start Vite: ${getSpawnError().message}`)
    }
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before startup: ${getOutput()}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) {
        const html = await response.text()
        if (html.includes('<div id="root"></div>') && html.includes('/src/main.jsx')) {
          return
        }
      }
    } catch {
      // The dev server is still binding its port.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for Vite: ${getOutput()}`)
}

async function waitForAttribute(page, name, predicate, timeoutMs = 5_000) {
  const html = page.locator('html')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await html.getAttribute(name)
    if (predicate(value)) return value
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${name}`)
}

async function preparePage(context, path, diagnostics) {
  const page = await context.newPage()
  page.on('pageerror', error => diagnostics.push({
    type: 'pageerror',
    message: error.stack || String(error),
  }))
  page.on('console', message => diagnostics.push({
    type: `console:${message.type()}`,
    message: message.text(),
  }))
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      realtimeProvider: 'browser-smoke',
      realtimeLabel: 'Browser Smoke',
      backend: { enabled: false, status: 'not_configured' },
    }),
  }))
  await page.addInitScript({ content: MOCK_BROWSER_APIS })
  await page.goto(`${baseUrl}/${path}`, { waitUntil: 'domcontentloaded' })
  if (process.env.QWEN_BROWSER_SMOKE_INJECT_ERROR === '1') {
    await page.evaluate(() => { setTimeout(() => { throw new Error('smoke diagnostic probe') }, 0) })
  }
  return page
}

async function finishPage(page, diagnostics) {
  assert.deepEqual(diagnostics.filter(item => item.type === 'pageerror' || item.type === 'console:error'), [],
    'Browser reported an unexpected error')
  await page.close()
}

async function testHappyPath(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=happy', diagnostics)
  const enable = page.getByRole('button', { name: '开启麦克风', exact: true })
  await enable.waitFor({ state: 'visible' })
  await enable.click()
  await page.getByRole('button', { name: '麦克风静音', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-media-requests', value => value === '1')
  await waitForAttribute(page, 'data-audio-appends', value => Number(value) >= 1)
  await waitForAttribute(page, 'data-playback-starts', value => Number(value) >= 1)

  assert.equal(await page.locator('html').getAttribute('data-audio-contexts'), '1')
  assert.equal(await page.locator('html').getAttribute('data-audio-closes') || '0', '0')
  assert.equal(await page.locator('html').getAttribute('data-track-stops') || '0', '0')

  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await page.getByRole('button', { name: '开启麦克风', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-track-stops', value => value === '1')
  await waitForAttribute(page, 'data-source-disconnects', value => value === '1')
  await waitForAttribute(page, 'data-processor-disconnects', value => value === '1')
  assert.equal(await page.locator('html').getAttribute('data-audio-closes') || '0', '0')
  await finishPage(page, diagnostics)
}

async function testReconnectInterruptsPlayback(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=reconnect', diagnostics)
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await page.getByRole('button', { name: '麦克风静音', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-media-requests', value => value === '1')
  await waitForAttribute(page, 'data-playback-starts', value => Number(value) >= 1)
  const first = await page.evaluate(() => window.browserSmoke.connection())
  assert.equal(first.ready, true)
  const previousStarts = Number(await page.locator('html').getAttribute('data-playback-starts'))
  await page.evaluate(() => window.browserSmoke.disconnect())
  await waitForAttribute(page, 'data-playback-stops', value => Number(value) >= 1)
  await page.waitForFunction(id => {
    const connection = window.browserSmoke.connection()
    return connection.ready && connection.id !== id
  }, first.id)
  const second = await page.evaluate(() => window.browserSmoke.connection())
  await waitForAttribute(page, 'data-negotiated-socket', value => value === String(second.id))
  await page.evaluate(() => { window.browserSmoke.stale(); window.browserSmoke.input() })
  await waitForAttribute(page, 'data-audio-socket', value => value === String(second.id))
  await waitForAttribute(page, 'data-playback-starts', value => Number(value) === previousStarts + 1)
  await page.getByText('Reply from connection ' + second.id, { exact: true }).waitFor()
  assert.equal(await page.getByText('STALE CONNECTION REPLY', { exact: true }).count(), 0)

  assert.equal(await page.locator('html').getAttribute('data-media-requests'), '1')
  assert.equal(await page.locator('html').getAttribute('data-processor-connects'), '1')
  assert.ok(Number(await page.locator('html').getAttribute('data-socket-connections')) >= 2)
  assert.equal(await page.locator('html').getAttribute('data-track-stops') || '0', '0')

  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await waitForAttribute(page, 'data-track-stops', value => value === '1')
  await finishPage(page, diagnostics)
}

async function testEndedTrackIsReacquired(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=track-ended', diagnostics)
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await page.getByRole('button', { name: '麦克风静音', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-media-requests', value => Number(value) >= 2)
  await waitForAttribute(page, 'data-track-stops', value => Number(value) >= 1)
  await waitForAttribute(page, 'data-source-disconnects', value => Number(value) >= 1)
  await waitForAttribute(page, 'data-processor-disconnects', value => Number(value) >= 1)
  await waitForAttribute(page, 'data-processor-connects', value => Number(value) >= 2)

  assert.equal(await page.locator('html').getAttribute('data-media-requests'), '2')
  assert.equal(await page.locator('html').getAttribute('data-track-stops'), '1')
  assert.equal(await page.locator('html').getAttribute('data-source-disconnects'), '1')
  assert.equal(await page.locator('html').getAttribute('data-processor-disconnects'), '1')
  assert.equal(await page.locator('html').getAttribute('data-processor-connects'), '2')
  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await page.getByRole('button', { name: '开启麦克风', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-track-stops', value => value === '2')
  await waitForAttribute(page, 'data-source-disconnects', value => value === '2')
  await waitForAttribute(page, 'data-processor-disconnects', value => value === '2')
  await finishPage(page, diagnostics)
}

async function testPermissionDenied(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=deny-microphone', diagnostics)
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await page.getByText('麦克风权限未开启，请在系统设置中允许后重试', { exact: true })
    .waitFor({ state: 'visible' })
  assert.equal(await page.locator('html').getAttribute('data-media-requests'), '1')
  assert.equal(await page.locator('html').getAttribute('data-track-stops') || '0', '0')
  await finishPage(page, diagnostics)
}

const server = startVite()
let browser
let context
let tracingActive = false
const diagnostics = []
const diagnosticsDirectory = resolve(
  projectRoot,
  'output/playwright/browser-webui-smoke',
  `${Date.now()}-${process.pid}`,
)
try {
  await waitForServer(server)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ locale: 'zh-CN' })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracingActive = true
  await testHappyPath(context, diagnostics)
  await testReconnectInterruptsPlayback(context, diagnostics)
  await testEndedTrackIsReacquired(context, diagnostics)
  await testPermissionDenied(context, diagnostics)
  await context.tracing.stop()
  tracingActive = false
  await context.close()
  context = null
  console.log('Browser WebUI voice smoke passed: happy path, reconnect continuation, track recovery, and permission denial.')
} catch (error) {
  await mkdir(diagnosticsDirectory, { recursive: true })
  const pages = context?.pages?.() || []
  await Promise.all(pages.map((page, index) => page.screenshot({
    path: join(diagnosticsDirectory, `failure-page-${index + 1}.png`),
    fullPage: true,
  }).catch(reason => diagnostics.push({
    type: 'screenshot-error',
    message: String(reason),
  }))))
  if (tracingActive) {
    await context.tracing.stop({
      path: join(diagnosticsDirectory, 'trace.zip'),
    }).catch(reason => diagnostics.push({
      type: 'trace-error',
      message: String(reason),
    }))
    tracingActive = false
  }
  await writeFile(
    join(diagnosticsDirectory, 'errors.log'),
    [
      `failure: ${error?.stack || error}`,
      ...diagnostics.map(item => `[${item.type}] ${item.message}`),
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(diagnosticsDirectory, 'vite.log'), server.getOutput(), 'utf8')
  if (error instanceof Error) {
    error.message = `${error.message} (diagnostics: ${diagnosticsDirectory})`
  }
  throw error
} finally {
  await context?.close()
  await browser?.close()
  if (server.vite.exitCode === null) server.vite.kill()
}
