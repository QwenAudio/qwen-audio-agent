import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const [webStyles, mobileStyles] = await Promise.all([
  readFile(resolve(root, 'web/src/styles.css'), 'utf8'),
  readFile(resolve(root, 'mobile/src/mobile.css'), 'utf8'),
])
const styles = `${webStyles}\n${mobileStyles}`
  .replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, 'var(--safe-area-$1)')

// Chromium does not expose device safe-area insets. Substitute only their
// values while keeping the production selectors, sizing and layout intact.
// This is an offline CSS fixture, not a React/native-device end-to-end test.
// Keep its controls aligned with App.jsx and MultimodalComposer.jsx: mobile
// has an icon-only microphone, no video toggle, and a one-row photo composer.
const microphone = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="9" y="3.5" width="6" height="11" rx="3" />
  <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3m-3 0h6" />
</svg>`
const appMarkup = (mobile = true) => `<main class="app">
    <header>
      <div class="brand"><span>V</span><div>qwen-audio-agent<small>REALTIME VOICE · LIVE</small></div></div>
      <a class="backend">Backend</a>
      <div class="model-status"><b>Realtime model</b><small>audio</small></div>
      <div class="status"><i class="listening"></i><span>正在听你说</span></div>
      <button class="ghost" data-action="knowledge" type="button">资料库</button>
      <button class="ghost" data-action="new-session" type="button">新会话</button>
      <button class="voice active" aria-label="麦克风静音" type="button">${mobile ? microphone : '麦克风静音'}</button>
      ${mobile ? '' : '<button class="video-toggle" type="button">开启视频</button>'}
    </header>
    <section class="workspace">
      <div class="hero">
        <button class="orb listening" aria-label="语音交互" type="button"><span></span></button>
        <p>VOICE FRONTEND</p><h1>你说，我来调度。</h1><small>正在听你说</small>
      </div>
      <div class="messages"><section class="conversation-turn">
        <article class="user"><label>你</label><p>你好</p></article>
        <article class="assistant"><label>qwen-audio</label><p>你好，有什么可以帮你？</p></article>
      </section></div>
      <form class="multimodal-composer"><div class="composer-row">
        <button class="composer-attach" type="button" aria-label="添加图片或文件">＋</button>
        <button class="composer-photo" type="button" aria-label="拍照">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l2-3h4l2 3h4v15H4V6z" /><circle cx="12" cy="13" r="4" /></svg>
        </button>
        <input type="file" multiple hidden />
        <textarea rows="1" placeholder="输入文字，或粘贴、拖入图片和文件"></textarea>
        <button class="composer-send" type="submit">发送</button>
      </div></form>
    </section>
  </main>`
const markup = `<div id="root"><div class="mobile-runtime">
  <button class="mobile-disconnect" type="button">断开</button>
  ${appMarkup()}
</div></div>`

const cases = [
  { width: 440, height: 956, top: 62, right: 0, bottom: 34, left: 0 },
  { width: 375, height: 812, top: 44, right: 0, bottom: 34, left: 0 },
  { width: 956, height: 440, top: 0, right: 62, bottom: 21, left: 62 },
  { width: 375, height: 440, top: 44, right: 0, bottom: 34, left: 0 },
  { width: 440, height: 956, top: 0, right: 0, bottom: 0, left: 0 },
  { width: 601, height: 440, top: 0, right: 0, bottom: 21, left: 0 },
  { width: 768, height: 1024, top: 24, right: 0, bottom: 20, left: 0 },
  { width: 1024, height: 768, top: 24, right: 0, bottom: 20, left: 0 },
]

async function assertClickable(page, selector, name) {
  const target = page.locator(selector)
  const point = await target.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return { x, y, hit: rect.width > 0 && rect.height > 0 && element.contains(document.elementFromPoint(x, y)) }
  })
  assert.ok(point.hit, `${name}: ${selector} is hidden, clipped, or covered`)
  const before = await target.getAttribute('data-clicks')
  await page.mouse.click(point.x, point.y)
  assert.equal(await target.getAttribute('data-clicks'), String(Number(before || 0) + 1),
    `${name}: ${selector} did not receive the fixture click`)
}

async function webLayout(page, css) {
  await page.setContent(`<style>${css}</style><div id="root">${appMarkup(false)}</div>`)
  await pauseAnimations(page)
  return page.locator('.app, .app *').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      tag: element.tagName,
      class: element.getAttribute('class'),
      top: rect.top, left: rect.left, width: rect.width, height: rect.height,
      styles: Object.fromEntries([
        'display', 'position', 'flex-direction', 'flex-grow', 'flex-shrink',
        'padding', 'margin', 'font-size', 'overflow', 'background-color',
      ].map(property => [property, style.getPropertyValue(property)])),
    }
  }))
}

async function pauseAnimations(page) {
  // Freeze the same frame in both comparisons without overriding production
  // selectors. Stateful orb animations can outrank the reduced-motion rule.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = 0
    }
  })
}

// CI installs Playwright's bundled Chromium. Local runs can opt into an
// installed browser without making branded Chrome a test prerequisite.
const channel = process.env.QWEN_BROWSER_CHANNEL?.trim()
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.route('**/*', route => route.abort())
  for (const scenario of cases) {
    const { width, height, top, right, bottom, left } = scenario
    const name = `${width}x${height} insets ${top}/${right}/${bottom}/${left}`
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>:root {
      --safe-area-top: ${top}px; --safe-area-right: ${right}px;
      --safe-area-bottom: ${bottom}px; --safe-area-left: ${left}px;
    }\n${styles}</style>${markup}`)
    await pauseAnimations(page)
    await page.evaluate(() => {
      document.querySelector('form').addEventListener('submit', event => event.preventDefault())
      for (const button of document.querySelectorAll('button')) {
        button.addEventListener('click', () => {
          button.dataset.clicks = String(Number(button.dataset.clicks || 0) + 1)
        })
      }
    })
    const selectors = [
      '.app', '.app > header', '.workspace', '.hero .orb', '.messages',
      '.multimodal-composer', '.composer-attach', '.composer-photo', '.composer-send',
      '.voice', '.mobile-disconnect',
      ...(width > 600 ? ['[data-action="knowledge"]', '[data-action="new-session"]'] : []),
    ]
    const boxes = await page.evaluate(selectors => {
      const result = {}
      for (const selector of selectors) {
        const element = document.querySelector(selector)
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        result[selector] = {
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
          height: rect.height, width: rect.width,
          contentHeight: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        }
      }
      return result
    }, selectors)
    for (const [selector, rect] of Object.entries(boxes)) {
      assert.ok(rect.width > 0 && rect.height > 0, `${name}: ${selector} has no visible box`)
      assert.ok(rect.top >= top - 1, `${name}: ${selector} overlaps the top safe area`)
      assert.ok(rect.bottom <= height - bottom + 1, `${name}: ${selector} overlaps the bottom safe area`)
      assert.ok(rect.left >= left - 1, `${name}: ${selector} overlaps the left safe area`)
      assert.ok(rect.right <= width - right + 1, `${name}: ${selector} overlaps the right safe area`)
    }
    assert.ok(boxes['.messages'].contentHeight >= 20, `${name}: messages have no readable content space`)
    assert.ok(boxes['.voice'].height >= 44, `${name}: microphone touch target is too small`)
    assert.ok(boxes['.voice'].width >= 44, `${name}: microphone touch target is too narrow`)
    for (const selector of ['.hero .orb', '.voice', '.composer-photo',
      ...(width > 600 ? ['[data-action="knowledge"]', '[data-action="new-session"]'] : [])]) {
      await assertClickable(page, selector, name)
    }
    console.log(`PASS ${name}`)
  }
  for (const viewport of [
    { width: 440, height: 956 },
    { width: 956, height: 440 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    const baseline = await webLayout(page, webStyles)
    const withMobileStyles = await webLayout(page, `${webStyles}\n${mobileStyles}`)
    const name = `WebUI isolation ${viewport.width}x${viewport.height}`
    assert.deepEqual(withMobileStyles, baseline, `${name}: mobile CSS changed the unwrapped WebUI`)
    console.log(`PASS ${name}`)
  }
} finally {
  await browser.close()
}
