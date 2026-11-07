import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const styles = (await Promise.all([
  readFile(resolve(root, 'web/src/styles.css'), 'utf8'),
  readFile(resolve(root, 'mobile/src/mobile.css'), 'utf8'),
])).join('\n').replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, 'var(--safe-area-$1)')

// Chromium does not expose device safe-area insets. Substitute only their
// values while keeping the production selectors, sizing and layout intact.
const markup = `
  <div id="root"><div class="mobile-runtime"><main class="app">
    <header>
      <div class="brand"><span>V</span><div>qwen-audio-agent<small>REALTIME VOICE · LIVE</small></div></div>
      <a class="backend">Backend</a>
      <div class="model-status"><b>Realtime model</b><small>audio</small></div>
      <div class="status"><i class="listening"></i><span>正在听你说</span></div>
      <button class="ghost">资料库</button><button class="ghost">新会话</button>
      <button class="voice active" aria-label="关闭语音"><svg></svg></button>
      <button class="video-toggle">开启视频</button>
    </header>
    <section class="workspace">
      <div class="hero">
        <button class="orb listening"><span></span></button>
        <p>VOICE FRONTEND</p><h1>你说，我来调度。</h1><small>正在听你说</small>
      </div>
      <div class="messages"><section class="conversation-turn">
        <article class="user"><label>你</label><p>你好</p></article>
        <article class="assistant"><label>qwen-audio</label><p>你好，有什么可以帮你？</p></article>
      </section></div>
      <div class="multimodal-composer"><div class="composer-row">
        <button class="composer-attach">+</button><textarea placeholder="发消息"></textarea>
        <button class="composer-send">↑</button>
      </div></div>
    </section>
  </main></div></div>`

const cases = [
  { width: 440, height: 956, top: 62, right: 0, bottom: 34, left: 0 },
  { width: 375, height: 812, top: 44, right: 0, bottom: 34, left: 0 },
  { width: 956, height: 440, top: 0, right: 62, bottom: 21, left: 62 },
  { width: 375, height: 440, top: 44, right: 0, bottom: 34, left: 0 },
  { width: 440, height: 956, top: 0, right: 0, bottom: 0, left: 0 },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  for (const scenario of cases) {
    const { width, height, top, right, bottom, left } = scenario
    const name = `${width}x${height} insets ${top}/${right}/${bottom}/${left}`
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>:root {
      --safe-area-top: ${top}px; --safe-area-right: ${right}px;
      --safe-area-bottom: ${bottom}px; --safe-area-left: ${left}px;
    }\n${styles}</style>${markup}`)
    const boxes = await page.evaluate(() => {
      const result = {}
      for (const selector of ['.app', '.workspace', '.messages', '.multimodal-composer', '.voice', '.video-toggle']) {
        const rect = document.querySelector(selector).getBoundingClientRect()
        result[selector] = {
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
          height: rect.height, width: rect.width,
        }
      }
      return result
    })
    for (const [selector, rect] of Object.entries(boxes)) {
      assert.ok(rect.top >= top - 1, `${name}: ${selector} overlaps the top safe area`)
      assert.ok(rect.bottom <= height - bottom + 1, `${name}: ${selector} overlaps the bottom safe area`)
      assert.ok(rect.left >= left - 1, `${name}: ${selector} overlaps the left safe area`)
      assert.ok(rect.right <= width - right + 1, `${name}: ${selector} overlaps the right safe area`)
    }
    assert.ok(boxes['.messages'].height > 0, `${name}: messages have no visible space`)
    assert.ok(boxes['.voice'].height >= 44, `${name}: microphone touch target is too small`)
    assert.ok(boxes['.voice'].width >= 44, `${name}: microphone touch target is too narrow`)
    console.log(`PASS ${name}`)
  }
} finally {
  await browser.close()
}
