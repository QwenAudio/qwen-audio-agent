// End-to-end browser smoke test for the digital-human demo, driven through this
// example's own avatar SPA (/skins/digital-human/index.html?persona=mock-default).
//
// Only the digital-human renderer is mocked. Voice uses the REAL Realtime
// upstream (DashScope), so this test needs network access and a valid
// DASHSCOPE_API_KEY in examples/digital-human/.env.local. It is intentionally
// NOT hermetic; deterministic coverage lives in the unit/contract tests
// (dhav-codec, renderer-server, provider-contract, media-adapter, spectrum).
//
// A text turn is injected through the avatar composer so the model produces
// speech without relying on a live microphone. The local Mock renderer turns
// that audio into paired DHAV A/V (an audio-reactive spectrum), and headless
// Chromium must actually paint avatar video frames while the state machine
// walks buffering -> committed_avatar -> draining -> terminal.
//
// Run: DASHSCOPE_API_KEY=... node examples/digital-human/test/browser-smoke.mjs [--fault=<name>] [--headed]

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { EXAMPLE_ROOT, loadDemoEnv } from '../bootstrap/env.mjs'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { startDigitalHumanGateway } from '../bootstrap/compose-gateway.mjs'

const argv = process.argv.slice(2)
const fault = argv.find(a => a.startsWith('--fault='))?.slice(8) || null
const headed = argv.includes('--headed')
const PROMPT = argv.find(a => a.startsWith('--prompt='))?.slice(9) || '请用一句话介绍你自己。'
const PROMPT_2 = argv.find(a => a.startsWith('--prompt2='))?.slice(10) || '再用一句话说明你能帮我做什么。'
const PERSONA = 'mock-default'

const stage = '[data-testid="avatar-stage"]'
const video = '[data-testid="avatar-video"]'

async function run() {
  // The real upstream needs a key; load the example's local env (falling back to
  // the repo-root .env.local for the key only) and fail fast with an actionable
  // message rather than silently degrading to a mock.
  if (!loadDemoEnv()) {
    throw new Error('DASHSCOPE_API_KEY is required for the browser smoke; set it in the environment, examples/digital-human/.env.local, or the repo-root .env.local')
  }
  if (!existsSync(`${EXAMPLE_ROOT}skins/digital-human/index.html`)) {
    throw new Error('skins/digital-human not found; run `npm run build:client` first so the Gateway can serve the avatar UI')
  }

  const directory = mkdtempSync(join(tmpdir(), 'dh-browser-'))
  Object.assign(process.env, {
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWAUDIO_CONFIG_DIR: directory,
    QWAUDIO_DATA_DIR: join(directory, 'data'),
    QWAUDIO_STATE_DIR: join(directory, 'state'),
    QWAUDIO_CACHE_DIR: join(directory, 'cache'),
    AGENT_PROTOCOL: 'none',
    QWEN_AUDIO_GATEWAY_ACCESS_TOKEN: '',
    QWEN_AUDIO_GATEWAY_ACCESS_KEYS: '',
    QWEN_AUDIO_GATEWAY_TAILNET: '0',
  })
  // Never point the realtime upstream at a mock: this smoke exercises the real one.
  delete process.env.QWEN_AUDIO_REALTIME_BASE_URL

  const renderer = await startMockRendererServer({
    host: '127.0.0.1', port: 0, fault,
    log: (name, fields) => console.error(`[renderer] ${name}`, fields ? JSON.stringify(fields) : ''),
  })
  const application = await startDigitalHumanGateway({
    host: '127.0.0.1', port: 0, rendererUrl: renderer.url, persona: PERSONA,
    mediaAdapterPath: fileURLToPath(new URL('../media/framed-av-source.mjs', import.meta.url)),
    envFile: null,
  })
  const origin = `http://127.0.0.1:${application.server.address().port}`

  let browser
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    })
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

    // Sample the avatar state history and painted-frame count off the stage's
    // data attributes so assertions are locale-independent.
    await page.addInitScript(() => {
      window.__avatarStates = []
      const sample = () => {
        const stage = document.querySelector('[data-testid="avatar-stage"]')
        if (!stage) return
        const state = stage.dataset.avatarState
        if (state && window.__avatarStates[window.__avatarStates.length - 1] !== state) {
          window.__avatarStates.push(state)
        }
      }
      setInterval(sample, 80)
    })

    const dump = async label => {
      const states = await page.evaluate(() => window.__avatarStates).catch(() => [])
      const stageNow = await page.evaluate(sel => {
        const element = document.querySelector(sel)
        if (!element) return null
        const { avatarState, connection, playback, visual, frameCount } = element.dataset
        return { avatarState, connection, playback, visual, frameCount, videoWidth: document.querySelector('[data-testid="avatar-video"]')?.videoWidth }
      }, stage).catch(() => null)
      const body = await page.locator('body').innerText().catch(() => '')
      throw new Error(`${label}\nstates=${JSON.stringify(states)}\nstage=${JSON.stringify(stageNow)}\nerrors=${errors.join('\n')}\nbody=${body.slice(0, 1200)}`)
    }

    await page.goto(`${origin}/skins/digital-human/index.html?persona=${PERSONA}`)
    await page.waitForSelector(stage, { timeout: 20000 }).catch(() => dump('avatar stage never rendered'))

    // The avatar session connection is persistent: it establishes on page load
    // without a microphone gesture (the autoplay/fake-media flags are set above),
    // so just wait for it to reach connected before injecting a text turn.
    await page.waitForFunction(
      sel => document.querySelector(sel)?.dataset.connection === 'connected',
      stage, { timeout: 30000 },
    ).catch(() => dump('session never became connected'))

    const frameCount = () => page.evaluate(sel => Number(document.querySelector(sel)?.dataset.frameCount || 0), stage)
    const videoWidth = () => page.evaluate(sel => document.querySelector(sel)?.videoWidth || 0, video)
    const assistantCount = () => page.evaluate(() => document.querySelectorAll('.messages article.assistant').length)
    const injectTurn = async text => {
      await page.getByTestId('avatar-input').fill(text)
      await page.getByTestId('avatar-send').click()
    }

    // --- Turn 1 ---
    await injectTurn(PROMPT)

    const degrade = fault === 'first_media_timeout'
    if (degrade) {
      // The renderer admits audio but never publishes media, so the selector must
      // fall back to audio-only and the <video> element must stay empty.
      await page.waitForFunction(
        sel => document.querySelector(sel)?.dataset.avatarState === 'audio_only',
        stage, { timeout: 45000 },
      ).catch(() => dump('never degraded to audio_only'))
      assert.equal(await frameCount(), 0, 'audio-only fallback must not paint avatar frames')
      assert.equal(await videoWidth(), 0, 'audio-only fallback must not size the video element')
      console.log(`[smoke] fault=${fault}: degraded to audio_only with no avatar video (correct)`)
      console.log('[smoke] PASS')
      return
    }

    // The avatar video element must report a real size and paint frames. The idle
    // animation paints from the moment the session opens, so frames alone do not
    // prove this turn ran. Wait on the sampler's own record rather than on the
    // live data attribute: reading the array the instant the state changes beats
    // the 80ms sampler to it and reports a stale history.
    await page.waitForFunction(sel => (document.querySelector(sel)?.videoWidth || 0) > 0, video, { timeout: 45000 })
      .catch(() => dump('no avatar video size'))
    await page.waitForFunction(
      () => window.__avatarStates.some(state => ['rendering', 'speaking'].includes(state)),
      null, { timeout: 45000 },
    ).catch(() => dump('turn1 never reached rendering/speaking'))
    await page.waitForFunction(
      sel => Number(document.querySelector(sel)?.dataset.frameCount || 0) > 2,
      stage, { timeout: 20000 },
    ).catch(() => dump('avatar frames not advancing'))

    const states = await page.evaluate(() => window.__avatarStates)
    assert.ok(!states.includes('audio_only'), `avatar should not degrade without a fault: ${JSON.stringify(states)}`)
    assert.ok(states.includes('speaking') || states.includes('rendering'),
      `expected the avatar to reach rendering/speaking, saw ${JSON.stringify(states)}`)
    console.log(`[smoke] turn1 frames: ${await frameCount()}; video ${await videoWidth()}px; states: ${JSON.stringify(states)}`)

    // The product transcript panel must show the assistant's words in avatar mode.
    await page.waitForFunction(
      () => document.querySelectorAll('.messages article.assistant').length > 0
        && document.querySelector('.messages article.assistant:last-of-type')?.innerText.trim().length > 0,
      null, { timeout: 20000 },
    ).catch(() => dump('assistant transcript never rendered in .messages'))
    console.log(`[smoke] turn1 transcript: ${(await page.locator('.messages article.assistant').last().innerText()).replace(/\s+/g, ' ').slice(0, 80)}`)

    // Let turn 1 finish on its own: response.done -> turn.completed + drained ->
    // client playback receipt -> idle. Turn 2 may only start once the provider has
    // released the previous turn, so wait for the stage to settle back to idle.
    await page.waitForFunction(
      sel => document.querySelector(sel)?.dataset.avatarState === 'idle',
      stage, { timeout: 30000 },
    ).catch(() => dump('turn1 never returned to idle'))
    const framesAfterTurn1 = await frameCount()

    // --- Turn 2: regression for "previous turn still active". turn.completed used
    // to leave the provider's currentTurn set, so the second reply produced audio
    // but no avatar video. The frame count must climb again on the same session. ---
    await injectTurn(PROMPT_2)
    await page.waitForFunction(
      ({ sel, base }) => Number(document.querySelector(sel)?.dataset.frameCount || 0) > base + 2,
      { sel: stage, base: framesAfterTurn1 }, { timeout: 45000 },
    ).catch(() => dump('turn2 avatar frames never advanced (second-turn regression)'))
    const framesTurn2 = await frameCount()
    assert.ok(framesTurn2 > framesAfterTurn1 + 2, `turn2 painted no new avatar frames (${framesAfterTurn1} -> ${framesTurn2})`)
    await page.waitForFunction(
      () => document.querySelectorAll('.messages article.assistant').length >= 2,
      null, { timeout: 20000 },
    ).catch(() => dump('turn2 assistant transcript never rendered'))
    console.log(`[smoke] turn2 frames advanced: ${framesAfterTurn1} -> ${framesTurn2}; assistant messages: ${await assistantCount()}`)

    console.log('[smoke] PASS')
  } finally {
    await browser?.close().catch(() => {})
    await application?.close().catch(() => {})
    await renderer?.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(() => process.exit(0)).catch(error => { console.error(`[smoke] FAIL: ${error.message}`); process.exit(1) })
}

export { run }
