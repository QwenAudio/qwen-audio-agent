const assert = require('node:assert/strict')
const { resolve } = require('node:path')

// Exercise the real React App and layout in Chromium. Only the voice/Gateway
// and host boundaries are replaced: no microphone, user data or backend agent.
module.exports = async function conversationSmoke({ BrowserWindow }) {
  const { createServer } = await import('vite')
  const server = await createServer({
    root: resolve(__dirname, '../../web'), configFile: false,
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{
      name: 'conversation-smoke-boundaries',
      load(id) {
        if (!id.endsWith('/realtime/useRealtimeVoice.js')) return null
        return `
          import { useEffect } from 'react'
          export const realtimeModelStatus = () => ({
            id: 'test', label: 'Test', modelInputModes: [], transportInputModes: [],
          })
          export const shouldClaimReleasedVoice = () => false
          const voice = { state: 'idle', connectionState: 'connected', ownership: {}, publishClientState() {} }
          export default function useRealtimeVoice({ onEvent }) {
            useEffect(() => {
              window.conversationRenderRevision = (window.conversationRenderRevision || 0) + 1
            })
            useEffect(() => {
              window.emitGatewayEvent = onEvent
              return () => { delete window.emitGatewayEvent }
            }, [onEvent])
            return voice
          }
        `
      },
      transformIndexHtml() {
        return [{ tag: 'script', injectTo: 'head-prepend', children: `
          window.fetch = async () => ({ ok: true, json: async () => ({
            ok: true, backend: { enabled: false },
          }) })
          window.qwenAudioAgentDesktop = {
            loadSurface: async () => ({ mode: new URLSearchParams(location.search).get('surface') || 'orb' }),
            setSurface: async mode => ({ mode }),
            setTaskCardCount() {},
            onLifecycle: () => () => {},
            loadLifecycle: async () => ({ state: 'active' }),
          }
        ` }]
      },
    }],
  })
  const window = new BrowserWindow({
    width: 440, height: 600, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, partition: 'conversation-smoke',
    },
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const evaluate = source => window.webContents.executeJavaScript(source)
  const waitFor = expression => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = () => {
      if (${expression}) return resolve()
      if (Date.now() > deadline) return reject(new Error(${JSON.stringify(`Timed out: ${expression}`)}))
      setTimeout(poll, 20)
    }
    poll()
  })`)
  const history = Array.from({ length: 40 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `History message ${index}`, turnId: `turn-${Math.floor(index / 2)}`,
  }))
  const recover = () => evaluate(`emitGatewayEvent(${JSON.stringify({
    type: 'session.recovered', messages: history, tasks: [],
  })})`)
  const atBottom = `(() => {
    const list = document.querySelector('.messages')
    return list && list.scrollHeight > list.clientHeight
      && Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 2
  })()`
  const openPanel = () => evaluate(`document.querySelector('[title="打开对话"]').click()`)
  const collapsePanel = () => evaluate(`document.querySelector('.desktop-panel-collapse').click()`)
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    await window.loadURL(`${origin}/?desktop=orb&lang=zh&autoHideSeconds=0`)
    await waitFor('typeof emitGatewayEvent === "function"')
    const beforeHistory = await evaluate('window.conversationRenderRevision')
    await recover()
    // Commit the history while the list is absent; opening must scroll even
    // without a subsequent message, task update or polling event.
    await waitFor(`window.conversationRenderRevision > ${beforeHistory}`)
    assert.equal(await evaluate('document.querySelector(".messages")'), null)
    await openPanel()
    await waitFor(atBottom)

    await evaluate(`(() => {
      const list = document.querySelector('.messages')
      list.scrollTop = 0
      list.dispatchEvent(new Event('scroll', { bubbles: true }))
      emitGatewayEvent({ type: 'transcript.final', role: 'assistant',
        responseId: 'new-reply', turnId: 'turn-20', content: 'New reply' })
    })()`)
    await waitFor('document.querySelector(".messages").textContent.includes("New reply")')
    assert.equal(await evaluate('document.querySelector(".messages").scrollTop'), 0,
      'incoming messages must not move a reader away from history')

    await collapsePanel()
    await waitFor('!document.querySelector(".messages")')
    await openPanel()
    await waitFor(atBottom)
    await evaluate(`emitGatewayEvent({ type: 'transcript.final', role: 'assistant',
      responseId: 'latest-reply', turnId: 'turn-21', content: 'Latest reply' })`)
    await waitFor('document.querySelector(".messages").textContent.includes("Latest reply")')
    await waitFor(atBottom)

    // Also cover history arriving after the panel was already mounted.
    await window.loadURL(`${origin}/?desktop=orb&surface=panel&lang=zh&autoHideSeconds=0`)
    await waitFor('typeof emitGatewayEvent === "function" && document.querySelector(".messages")')
    await recover()
    await waitFor(atBottom)
    await evaluate(`(() => {
      const list = document.querySelector('.messages')
      list.scrollTop = 0
      list.dispatchEvent(new Event('scroll', { bubbles: true }))
      document.querySelector('.desktop-new-session').click()
    })()`)
    await waitFor('document.querySelector(".messages .empty")')
    await recover()
    await waitFor(atBottom)
  } finally {
    window.destroy()
    await server.close()
  }
}
