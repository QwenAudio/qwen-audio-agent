import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { build } from 'vite'
import { startDesktopRendererServer } from '../../desktop/src/renderer-server.mjs'
import { GATEWAY_CLIENT_PROTOCOL_VERSION, GatewayClientProtocolEvent } from '../../shared/protocol/gateway-client-protocol.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')
const webRoot = resolve(projectRoot, 'web')
const port = Number(process.env.QWEN_BROWSER_SMOKE_PORT || 4174)
const baseUrl = `http://127.0.0.1:${port}`

// Keep the browser test deterministic and offline: the page gets a local
// protocol double. Lifecycle cases use controlled media doubles; the real-audio
// case uses Chromium's fake microphone with native Web Audio and AudioWorklet.
const MOCK_BROWSER_APIS = String.raw`
(() => {
  const protocolVersion = ${JSON.stringify(GATEWAY_CLIENT_PROTOCOL_VERSION)}
  const desktop = new URLSearchParams(location.search).get('desktop') === 'orb'
  const videoCall = location.search.includes('video-call')
  const realAudio = location.search.includes('browser-smoke=real-audio') || videoCall
  const state = {
    mediaRequests: 0,
    cameraRequests: 0,
    cameraStops: 0,
    imageAppends: 0,
    imageClears: 0,
    visualStateEvents: 0,
    visualStates: [],
    presenceContexts: [],
    trackStops: 0,
    audioContexts: 0,
    audioCloses: 0,
    sourceConnects: 0,
    sourceDisconnects: 0,
    processorConnects: 0,
    processorDisconnects: 0,
    audioAppends: 0,
    nonSilentAudioAppends: 0,
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
      this.bufferedAmount = 0
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
        if (message.protocol?.min !== protocolVersion || message.protocol?.max !== protocolVersion) {
          throw new Error('Browser smoke received an unexpected Gateway protocol version')
        }
        setTimeout(() => {
          if (this.readyState !== MockWebSocket.OPEN) return
          increment('sessionReadyEvents')
          serverEvent(this, {
            type: 'session.ready',
            request_event_id: message.event_id,
            protocol_version: protocolVersion,
            session_id: 'browser-smoke',
            capabilities: ['session.heartbeat', 'client.events', ...(desktop ? ['client.tools', 'client.presence'] : []), ...(videoCall ? ['input.image_buffer'] : [])],
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
        if ([...atob(message.audio)].some(byte => byte.charCodeAt(0) !== 0)) {
          increment('nonSilentAudioAppends')
        }
        document.documentElement.dataset.audioSocket = String(this.id)
        if (this.replied) return
        this.replied = true
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
      if (message.type === ${JSON.stringify(GatewayClientProtocolEvent.INPUT_IMAGE_APPEND)}) increment('imageAppends')
      if (message.type === ${JSON.stringify(GatewayClientProtocolEvent.INPUT_IMAGE_CLEAR)}) increment('imageClears')
      if (message.type === 'client.event.publish' && message.name === 'media.visual_input.changed') {
        increment('visualStateEvents')
        const visualState = message.text.includes('已开启') ? 'active' : 'inactive'
        state.visualStates.push(visualState)
        document.documentElement.dataset.visualInputState = visualState
        if (message.delivery_hint !== 'context') throw new Error('Visual state must be context-only')
        serverEvent(this, { type: 'client.event.publish.result', request_event_id: message.event_id,
          accepted: true, name: message.name })
      }
      if (message.type === 'client.event.publish' && message.name === 'desktop.presence.changed') {
        if (message.delivery_hint !== 'context') throw new Error('Presence must not trigger a reply')
        state.presenceContexts.push(message.text)
        document.documentElement.dataset.presenceContext = message.text
        serverEvent(this, { type: 'client.event.publish.result', request_event_id: message.event_id,
          accepted: true, name: message.name })
      }
      if (message.type === 'playback.started') {
        document.documentElement.dataset.playbackResponse = message.responseId
      }
      if (message.type === 'client.action.result') {
        document.documentElement.dataset.actionResult = message.status
      }
      if (message.type === 'client.presence.update') {
        document.documentElement.dataset.clientPresence = message.state
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

  class MockAudioWorkletNode {
    constructor() {
      const channel = new MessageChannel()
      this.port = channel.port1
      this.producer = channel.port2
      this.connected = false
    }

    input() {
      if (!this.connected) return
      const samples = Float32Array.from([0.1, 0.2, 0.3, 0.4]).buffer
      this.producer.postMessage({ type: 'samples', samples }, [samples])
    }

    connect() {
      if (this.connected) return
      this.connected = true
      increment('processorConnects')
      state.processor = this
      setTimeout(() => this.input(), 0)
    }

    disconnect() {
      this.connected = false
      this.producer.close()
      increment('processorDisconnects')
    }
  }

  class MockAudioContext {
    constructor() {
      increment('audioContexts')
      this.state = 'suspended'
      this.currentTime = 0
      this.sampleRate = 48_000
      this.destination = {}
      this.audioWorklet = { addModule: async () => {} }
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

  if (realAudio) {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      increment('mediaRequests')
      if (constraints.video) {
        increment('cameraRequests')
        if (location.search.includes('deny-camera') && state.cameraRequests === 1) {
          throw new DOMException('Camera permission denied', 'NotAllowedError')
        }
        if (location.search.includes('delay-camera')) {
          await new Promise(resolve => { state.releaseCamera = resolve })
        }
      }
      const media = await getUserMedia(constraints)
      if (constraints.video) state.cameraStream = media
      for (const track of media.getTracks()) {
        const stop = track.stop.bind(track)
        track.stop = () => {
          increment(track.kind === 'video' ? 'cameraStops' : 'trackStops')
          stop()
        }
      }
      return media
    }
  } else {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
    window.AudioContext = MockAudioContext
    window.webkitAudioContext = MockAudioContext
    window.AudioWorkletNode = MockAudioWorkletNode
  }
  window.WebSocket = MockWebSocket
  if (desktop) {
    let lifecycle = 'active'
    let lifecycleReason = ''
    let surface = 'panel'
    let listener
    const emitLifecycle = (value, reason) => {
      lifecycle = value
      lifecycleReason = reason
      document.documentElement.dataset.desktopLifecycle = value
      listener?.({ state: value, reason })
    }
    window.qwenAudioAgentDesktop = {
      loadSurface: async () => ({ mode: surface }),
      setSurface: async mode => { surface = mode; return { mode } },
      setTaskCardCount() {},
      onLifecycle(callback) { listener = callback; return () => { listener = null } },
      loadLifecycle: async () => ({ state: lifecycle, reason: lifecycleReason }),
      enterHide: async options => {
        emitLifecycle('hidden', options?.explicit ? 'requested' : 'inactivity')
        surface = 'orb'
        return { state: lifecycle, reason: lifecycleReason }
      },
      wake: () => emitLifecycle('waking', 'shortcut'),
      lifecycleReady: () => { if (lifecycle === 'waking') emitLifecycle('active', 'ready') },
    }
  }
  window.browserSmoke = {
    sleepTool() {
      document.documentElement.dataset.actionResult = ''
      serverEvent(state.activeSocket, { type: 'client.action.request',
        name: 'client.tool.enter_sleep', arguments: {} })
    },
    connection: () => ({ id: state.activeSocket?.id, ready: state.activeSocket?.handshakeReady }),
    disconnect() { state.oldSocket = state.activeSocket; state.oldSocket.close() },
    input() { state.processor?.input() },
    setBufferedAmount(bytes) { state.activeSocket.bufferedAmount = bytes },
    releaseCamera() { state.releaseCamera?.() },
    visualStates: () => [...state.visualStates],
    presenceContexts: () => [...state.presenceContexts],
    endCamera() { state.cameraStream?.getVideoTracks()[0].dispatchEvent(new Event('ended')) },
    restartRealtime() {
      serverEvent(state.activeSocket, { type: 'voice.connection', state: 'connecting' })
      setTimeout(() => serverEvent(state.activeSocket, { type: 'voice.ready', inputSampleRate: 16_000 }), 100)
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
    [resolve(projectRoot, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  vite.stdout.on('data', chunk => { output += chunk.toString() })
  vite.stderr.on('data', chunk => { output += chunk.toString() })
  return { vite, getOutput: () => output }
}

async function waitForServer(vite, getOutput) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before startup: ${getOutput()}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
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

async function preparePage(context, path, diagnostics, pageBaseUrl = `${baseUrl}/`) {
  const page = await context.newPage()
  page.on('pageerror', error => diagnostics.push({
    type: 'pageerror',
    message: error.stack || String(error),
  }))
  page.on('console', message => diagnostics.push({
    type: `console:${message.type()}`,
    message: message.text(),
  }))
  const videoProfile = path.includes('video-call') ? {
    id: 'test-omni', label: 'Test Omni', family: 'omni',
    modelCapabilities: { textInput: true, audioInput: true, imageInput: true, videoInput: true },
    transportCapabilities: { textInput: true, audioInput: true, imageBufferInput: !path.includes('no-video-transport') },
  } : null
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      realtimeProvider: 'browser-smoke',
      realtimeLabel: 'Browser Smoke',
      ...(videoProfile ? { realtimeModel: videoProfile.id, realtimeModelProfile: videoProfile,
        realtimeModelCatalog: [videoProfile] } : {}),
      backend: { enabled: false, status: 'not_configured' },
    }),
  }))
  await page.addInitScript({ content: MOCK_BROWSER_APIS })
  await page.goto(new URL(path, pageBaseUrl).href, { waitUntil: 'domcontentloaded' })
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
  assert.equal(await page.locator('html').getAttribute('data-track-stops') || '0', '0')

  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await page.getByRole('button', { name: '开启麦克风', exact: true })
    .waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-track-stops', value => value === '1')
  await waitForAttribute(page, 'data-source-disconnects', value => value === '1')
  await waitForAttribute(page, 'data-processor-disconnects', value => value === '1')
  await finishPage(page, diagnostics)
}

async function testBrowserLanguage(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=language', diagnostics)
  await page.evaluate(() => {
    localStorage.setItem('qwen-audio-lang', 'zh-CN')
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] })
    window.dispatchEvent(new Event('languagechange'))
  })
  await page.getByRole('button', { name: 'Enable microphone', exact: true }).waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] })
    window.dispatchEvent(new Event('languagechange'))
  })
  await page.getByRole('button', { name: '开启麦克风', exact: true }).waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await page.evaluate(() => localStorage.removeItem('qwen-audio-lang'))
  await finishPage(page, diagnostics)
}

async function testDesktopSleepWake(context, diagnostics) {
  const page = await preparePage(context, '?desktop=orb&surface=panel&lang=zh&autoHideSeconds=0', diagnostics)
  await page.locator('.messages').waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-audio-appends', value => Number(value) >= 1)
  const socket = await page.evaluate(() => browserSmoke.connection().id)
  await waitForAttribute(page, 'data-presence-context', value => value?.includes('不在休眠状态'))
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.evaluate(() => browserSmoke.sleepTool())
    await waitForAttribute(page, 'data-action-result', value => value === 'completed')
    await waitForAttribute(page, 'data-client-presence', value => value === 'sleeping')
    await waitForAttribute(page, 'data-presence-context', value => value?.includes('已执行休眠请求'))
    await page.locator('.messages').waitFor({ state: 'detached' })
    await waitForAttribute(page, 'data-track-stops', value => Number(value) >= cycle + 1)
    // Wake without another voice.ready/connected: the Realtime session is retained.
    await page.evaluate(() => qwenAudioAgentDesktop.wake())
    await waitForAttribute(page, 'data-desktop-lifecycle', value => value === 'active')
    await waitForAttribute(page, 'data-client-presence', value => value === 'active')
    await waitForAttribute(page, 'data-presence-context', value => value?.includes('不在休眠状态'))
    await waitForAttribute(page, 'data-media-requests', value => Number(value) >= cycle + 2)
    assert.equal(await page.evaluate(() => browserSmoke.connection().id), socket)
    // Orb controls are exposed on hover; invoke the control independently of
    // the pet's animated hit target so this tests lifecycle, not pointer layout.
    await page.getByTitle('打开对话', { exact: true }).evaluate(button => button.click())
    await page.locator('.messages').waitFor({ state: 'visible' })
  }
  const states = await page.evaluate(() => browserSmoke.presenceContexts())
  assert.deepEqual(states.map(text => text.includes('不在休眠状态') ? 'active' : 'hidden'),
    ['active', 'hidden', 'active', 'hidden', 'active'],
    'each real transition updates model context once; waking -> active must not duplicate it')
  await finishPage(page, diagnostics)
}

async function testDesktopAutoSleep(context, diagnostics) {
  const page = await preparePage(context, '?desktop=orb&surface=panel&lang=zh&autoHideSeconds=60', diagnostics)
  await page.locator('.messages').waitFor({ state: 'visible' })
  await waitForAttribute(page, 'data-audio-appends', value => Number(value) >= 1)
  await page.clock.install()
  await page.clock.fastForward(61_000)
  assert.equal(await page.locator('html').getAttribute('data-client-presence'), 'active',
    'an open panel must not auto-hide')
  await page.locator('.desktop-panel-collapse').click()
  await page.locator('.messages').waitFor({ state: 'detached' })
  await page.clock.fastForward(61_000)
  await waitForAttribute(page, 'data-client-presence', value => value === 'sleeping')
  await waitForAttribute(page, 'data-presence-context', value => value?.includes('因空闲超时'))
  await page.evaluate(() => qwenAudioAgentDesktop.wake())
  await waitForAttribute(page, 'data-desktop-lifecycle', value => value === 'active')
  await waitForAttribute(page, 'data-presence-context', value => value?.includes('不在休眠状态'))
  const states = await page.evaluate(() => browserSmoke.presenceContexts())
  assert.equal(states.length, 3, 'initial state, automatic sleep and wake each publish once')
  assert.match(states[1], /自动进入休眠/)
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
  await waitForAttribute(page, 'data-processor-connects', value => Number(value) >= 2)

  assert.equal(await page.locator('html').getAttribute('data-media-requests'), '2')
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

async function testNativeAudioWorklet(context, diagnostics, pageBaseUrl) {
  const page = await preparePage(context, '?browser-smoke=real-audio', diagnostics, pageBaseUrl)
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await page.getByRole('button', { name: '麦克风静音', exact: true })
    .waitFor({ state: 'visible' })
  // Native capture, processor module loading, MessagePort delivery, resampling,
  // and Gateway serialization must all work in the production bundle.
  await waitForAttribute(page, 'data-non-silent-audio-appends', value => Number(value) > 0)
  await page.evaluate(() => window.browserSmoke.setBufferedAmount(128 * 1024))
  await delay(100)
  const paused = await page.locator('html').getAttribute('data-audio-appends')
  await delay(150)
  assert.equal(await page.locator('html').getAttribute('data-audio-appends'), paused,
    'Capture must respect socket backpressure')
  await page.evaluate(() => window.browserSmoke.setBufferedAmount(0))
  await waitForAttribute(page, 'data-audio-appends', value => Number(value) > Number(paused))
  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await waitForAttribute(page, 'data-track-stops', value => value === '1')
  const stopped = await page.locator('html').getAttribute('data-audio-appends')
  await delay(150)
  assert.equal(await page.locator('html').getAttribute('data-audio-appends'), stopped,
    'Muted capture must not forward queued worklet samples')
  await finishPage(page, diagnostics)
}

async function testDesktopAudioWorklet(context, diagnostics) {
  const renderer = await startDesktopRendererServer({
    webRoot: resolve(webRoot, 'dist'),
    target: baseUrl,
  })
  try {
    const response = await fetch(renderer.baseUrl)
    assert.equal(response.status, 200)
    const scriptPolicy = response.headers.get('content-security-policy')
      ?.split(';').map(directive => directive.trim())
      .find(directive => directive.startsWith('script-src '))
    assert.equal(scriptPolicy, "script-src 'self'",
      'Desktop audio capture must work without relaxing the script policy')
    await testNativeAudioWorklet(context, diagnostics, renderer.baseUrl)
  } finally {
    await renderer.close()
  }
}

async function testVideoCall(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=video-call', diagnostics)
  await page.setViewportSize({ width: 1280, height: 900 })
  const html = page.locator('html')
  await page.getByRole('button', { name: '开启麦克风', exact: true }).waitFor()
  await page.getByRole('button', { name: '开启视频', exact: true }).waitFor()
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'inactive')
  assert.equal(await html.getAttribute('data-camera-requests'), null, 'No camera capture before a click')
  assert.equal(await page.locator('.composer-camera').count(), 0)
  await page.getByRole('button', { name: '开启视频', exact: true }).click()
  await page.getByRole('region', { name: '视频通话', exact: true }).waitFor()
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > 0)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'active')
  assert.equal(await html.getAttribute('data-audio-appends'), null, 'Video must not start the microphone')
  assert.equal(await html.getAttribute('data-media-requests'), '1', 'Video requests only camera permission')
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await waitForAttribute(page, 'data-non-silent-audio-appends', v => Number(v) > 0)
  await page.getByRole('button', { name: '关闭摄像头', exact: true }).click()
  await waitForAttribute(page, 'data-camera-stops', v => Number(v) === 1)
  await waitForAttribute(page, 'data-image-clears', v => Number(v) >= 1)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'inactive')
  const paused = Number(await html.getAttribute('data-image-appends'))
  const audio = Number(await html.getAttribute('data-audio-appends'))
  await delay(1200)
  assert.equal(Number(await html.getAttribute('data-image-appends')), paused)
  assert.ok(Number(await html.getAttribute('data-audio-appends')) > audio, 'Camera off must keep voice live')
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click()
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > paused)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'active')
  const stateEvents = Number(await html.getAttribute('data-visual-state-events'))
  assert.equal(await html.getAttribute('data-camera-requests'), '2')
  await page.getByRole('button', { name: '麦克风静音', exact: true }).click()
  await waitForAttribute(page, 'data-track-stops', v => Number(v) === 1)
  const muted = Number(await html.getAttribute('data-image-appends'))
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > muted)
  assert.equal(Number(await html.getAttribute('data-visual-state-events')), stateEvents,
    'Frames, renders and microphone mute must not republish unchanged visual state')
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  // A responsive-layout switch and a reconnect must not reacquire the camera.
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.locator('.camera-stream-docked video').waitFor()
  const beforeResize = Number(await html.getAttribute('data-image-appends'))
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > beforeResize)
  await page.evaluate(() => window.browserSmoke.disconnect())
  await waitForAttribute(page, 'data-session-ready-events', v => Number(v) >= 2)
  const reconnected = Number(await html.getAttribute('data-image-appends'))
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > reconnected)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'active')
  assert.equal(await html.getAttribute('data-camera-requests'), '2')
  await page.getByRole('button', { name: '关闭视频', exact: true }).click()
  await page.getByRole('region', { name: '视频通话', exact: true }).waitFor({ state: 'detached' })
  await waitForAttribute(page, 'data-camera-stops', v => Number(v) === 2)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'inactive')
  await page.getByRole('button', { name: '开启视频', exact: true }).waitFor()
  assert.equal(await html.getAttribute('data-track-stops'), '1', 'Closing video must not mute the microphone')
  const stopped = Number(await html.getAttribute('data-image-appends'))
  await delay(1200)
  assert.equal(Number(await html.getAttribute('data-image-appends')), stopped)
  const beforeRestart = Number(await html.getAttribute('data-visual-state-events'))
  await page.evaluate(() => window.browserSmoke.restartRealtime())
  await waitForAttribute(page, 'data-visual-state-events', value => Number(value) > beforeRestart)
  assert.equal(await html.getAttribute('data-visual-input-state'), 'inactive',
    'Rebuilding Realtime must restore inactive state even after the preview unmounts')
  await finishPage(page, diagnostics)
}

async function testCameraPermission(context, diagnostics) {
  const page = await preparePage(context, '?browser-smoke=video-call-deny-camera', diagnostics)
  await page.getByRole('button', { name: '开启麦克风', exact: true }).click()
  await page.getByRole('button', { name: '开启视频', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '无法打开相机' }).waitFor()
  await waitForAttribute(page, 'data-audio-appends', v => Number(v) > 0)
  assert.equal(await page.locator('html').getAttribute('data-image-appends'), null)
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click()
  await waitForAttribute(page, 'data-image-appends', v => Number(v) > 0)
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'active')
  await page.evaluate(() => window.browserSmoke.endCamera())
  await waitForAttribute(page, 'data-visual-input-state', value => value === 'inactive')
  await waitForAttribute(page, 'data-camera-stops', value => Number(value) === 1)
  await finishPage(page, diagnostics)

  const pending = await preparePage(context, '?browser-smoke=video-call-delay-camera', diagnostics)
  await pending.getByRole('button', { name: '开启视频', exact: true }).click()
  await waitForAttribute(pending, 'data-camera-requests', v => v === '1')
  await pending.getByRole('button', { name: '关闭视频，保留语音', exact: true }).click()
  await pending.evaluate(() => window.browserSmoke.releaseCamera())
  await waitForAttribute(pending, 'data-camera-stops', v => v === '1')
  assert.equal(await pending.locator('html').getAttribute('data-image-appends'), null,
    'A late permission grant must not reopen video capture')
  assert.ok((await pending.evaluate(() => window.browserSmoke.visualStates())).every(state => state === 'inactive'))
  await finishPage(pending, diagnostics)

  const unsupported = await preparePage(context, '?browser-smoke=video-call-no-video-transport', diagnostics)
  await unsupported.getByRole('button', { name: '开启麦克风', exact: true }).waitFor()
  assert.equal(await unsupported.getByRole('button', { name: '开启视频', exact: true }).count(), 0)
  await finishPage(unsupported, diagnostics)
}

let server
let browser
let context
let tracingActive = false
const diagnostics = []
const diagnosticsDirectory = resolve(projectRoot, 'output/playwright/browser-webui-smoke', String(Date.now()))
try {
  await build({ root: webRoot, logLevel: 'warn' })
  server = startVite()
  await waitForServer(server.vite, server.getOutput)
  browser = await chromium.launch({ headless: true, args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ] })
  context = await browser.newContext({ locale: 'zh-CN' })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracingActive = true
  await testHappyPath(context, diagnostics)
  await testBrowserLanguage(context, diagnostics)
  await testReconnectInterruptsPlayback(context, diagnostics)
  await testEndedTrackIsReacquired(context, diagnostics)
  await testPermissionDenied(context, diagnostics)
  await testNativeAudioWorklet(context, diagnostics)
  await testDesktopAudioWorklet(context, diagnostics)
  await testDesktopSleepWake(context, diagnostics)
  await testDesktopAutoSleep(context, diagnostics)
  await testVideoCall(context, diagnostics)
  await testCameraPermission(context, diagnostics)
  await context.tracing.stop()
  tracingActive = false
  await context.close()
  context = null
  console.log('Browser WebUI smoke passed: voice lifecycle, native AudioWorklet capture, desktop CSP, sleep/wake cycles, video-call entry, camera toggle, reconnect, responsive dock and permission recovery.')
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
  await writeFile(join(diagnosticsDirectory, 'vite.log'), server?.getOutput() || '', 'utf8')
  if (error instanceof Error) {
    error.message = `${error.message} (diagnostics: ${diagnosticsDirectory})`
  }
  throw error
} finally {
  await context?.close()
  await browser?.close()
  if (server?.vite.exitCode === null) server.vite.kill()
}
