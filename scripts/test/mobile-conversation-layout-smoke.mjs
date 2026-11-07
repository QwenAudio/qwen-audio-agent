import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const styles = await Promise.all([
  readFile(resolve(root, 'web/src/styles.css'), 'utf8'),
  readFile(resolve(root, 'mobile/src/mobile.css'), 'utf8'),
])
const browser = await chromium.launch({
  headless: true,
  ...(process.env.QWEN_BROWSER_CHANNEL
    ? { channel: process.env.QWEN_BROWSER_CHANNEL }
    : {}),
})

try {
  // Exercise the shared conversation shell with production CSS, without
  // requiring a Gateway, microphone permission, or a saved device profile.
  for (const viewport of [
    { width: 440, height: 956 },
    { width: 375, height: 812 },
    { width: 956, height: 440 },
    { width: 375, height: 440 },
  ]) {
    const page = await browser.newPage({ viewport })
    await page.setContent(`<style>${styles.join('\n')}</style>
      <div class="mobile-runtime"><button class="mobile-disconnect">断开</button><main class="app">
        <header><div class="brand"><span>V</span><div>qwen-audio-agent</div></div>
          <div class="status"><i></i><span>正在聆听</span></div>
          <button class="voice active" aria-label="关闭麦克风">麦克风</button>
        </header>
        <section class="workspace">
          <div class="hero"><button class="orb" aria-label="语音交互"><span></span></button>
            <p>VOICE FRONTEND</p><h1>你说，我来调度。</h1><small>正在聆听</small></div>
          <div class="messages"><div class="empty">试着说</div></div>
          <div class="multimodal-composer"><div class="composer-row">
            <textarea aria-label="输入消息"></textarea><button class="composer-send">发送</button>
          </div></div>
        </section>
      </main></div>`)

    const welcome = await page.locator('.hero').boundingBox()
    const beforeMessages = await page.locator('.messages').boundingBox()
    assert.ok(welcome.height > 100, 'empty session retains the welcome area')
    for (const content of [
      '<article class="user">你好</article>',
      '<aside class="agent-task">正在处理任务</aside>',
    ]) {
      await page.locator('.messages').evaluate((node, html) => {
        node.innerHTML = `<section class="conversation-turn">${html}</section>`
      }, content)
      assert.equal(await page.locator('.hero h1').isVisible(), false)
      assert.equal(await page.locator('.hero p').isVisible(), false)
      assert.equal(await page.locator('.hero .orb').isVisible(), false)
      assert.equal(await page.locator('header .voice').isVisible(), true)
      const compact = await page.locator('.hero').boundingBox()
      const messages = await page.locator('.messages').boundingBox()
      assert.ok(compact.height < 60, 'conversation keeps only a compact status line')
      assert.ok(messages.height - beforeMessages.height > 100,
        'conversation gains space previously occupied by welcome decorations')
      await page.locator('.hero small').evaluate(node => {
        node.textContent = 'Connection error: the Gateway is unavailable. Please check the connection and try again.'
      })
      assert.equal(await page.locator('.hero small').isVisible(), true,
        'connection errors remain visible during a conversation')
      const disconnect = await page.locator('.mobile-disconnect').boundingBox()
      const errorLines = await page.locator('.hero small').evaluate(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return Array.from(range.getClientRects(), rect => ({
          top: rect.top, right: rect.right, bottom: rect.bottom,
        }))
      })
      for (const line of errorLines) {
        if (line.top < disconnect.y + disconnect.height && line.bottom > disconnect.y) {
          assert.ok(line.right <= disconnect.x,
            'the disconnect button must not cover connection error text')
        }
      }
    }
    await page.locator('.messages').evaluate(node => {
      node.innerHTML = '<div class="empty">试着说</div>'
    })
    assert.equal(await page.locator('.hero h1').isVisible(), true,
      'resetting the session restores the welcome area')

    await page.locator('.messages').evaluate(node => {
      node.innerHTML = '<section class="conversation-turn"><article>你好</article></section>'
    })
    await page.locator('.mobile-runtime').evaluate(node => node.classList.remove('mobile-runtime'))
    assert.equal(await page.locator('.hero h1').isVisible(), true,
      'the WebUI welcome area is unaffected')
    console.log(`PASS mobile conversation layout ${viewport.width}x${viewport.height}`)
    await page.close()
  }
} finally {
  await browser.close()
}
