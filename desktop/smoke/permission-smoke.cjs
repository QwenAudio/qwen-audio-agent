const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { resolve, join } = require('node:path')

// Render the shared permission component with the production stylesheet in
// Chromium. No Gateway connection or real permission operation is involved.
module.exports = async function permissionSmoke({ BrowserWindow }) {
  const { createServer } = await import('vite')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const server = await createServer({
    root: resolve(__dirname, '../../web'), configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  const window = new BrowserWindow({
    width: 420, height: 260, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true },
  })
  try {
    const Component = (await server.ssrLoadModule('/src/PermissionActions.jsx')).default
    const { setRuntimeLanguage } = await server.ssrLoadModule('/src/i18n.js')
    const css = await readFile(resolve(__dirname, '../../web/src/styles.css'), 'utf8')
    for (const lang of ['zh', 'en']) {
      setRuntimeLanguage(lang)
      const title = lang === 'zh' ? '等待你的确认' : 'Waiting for your confirmation'
      const detail = lang === 'zh' ? '读取磁盘使用情况' : 'Read disk usage information'
      const actions = renderToStaticMarkup(createElement(Component, { authorization: {} }))
      for (const width of [320, 420, 760]) {
        window.setContentSize(width, 260)
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
          <!doctype html><html lang="${lang}"><head><style>${css}
          *, *::before, *::after { animation: none !important; transition: none !important; }
          </style></head>
          <body><main style="width:100%;padding-top:32px">
            <aside class="agent-task awaiting-permission">
              <span class="task-spinner"></span>
              <div><b>${title}</b><small>${detail}</small></div>
              <div class="task-controls">${actions}<time>155s</time></div>
            </aside>
          </main></body></html>
        `)}`)
        const layout = await window.webContents.executeJavaScript(`(() => {
          const card = document.querySelector('.agent-task').getBoundingClientRect()
          return [...document.querySelectorAll('.permission-actions button')].map(button => {
            const rect = button.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(button)
            return {
              width: rect.width, height: rect.height, top: rect.top,
              inside: rect.left >= card.left && rect.right <= card.right,
              lines: range.getClientRects().length,
            }
          })
        })()`)
        assert.equal(layout.length, 3)
        assert.ok(layout.every(button => button.inside && button.lines === 1), `${lang}/${width}: ${JSON.stringify(layout)}`)
        assert.ok(layout.every(button => Math.abs(button.width - layout[0].width) < 1))
        assert.ok(layout.every(button => button.top === layout[0].top && button.height >= 32), `${lang}/${width}: ${JSON.stringify(layout)}`)
        if (process.env.QWAUDIO_PERMISSION_PREVIEW_DIR && width === 420) {
          const screenshot = await window.webContents.capturePage()
          await writeFile(join(process.env.QWAUDIO_PERMISSION_PREVIEW_DIR, `permission-${lang}.png`), screenshot.toPNG())
        }
      }
    }
  } finally {
    window.destroy()
    await server.close()
  }
}
