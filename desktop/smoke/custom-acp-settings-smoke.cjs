const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { parseEnv } = require('node:util')

// Real renderer, preload and settings store; no Gateway or custom command is started.
module.exports = async function customAcpSettingsSmoke({ BrowserWindow, ipcMain }) {
  const { createSettingsStore } = await import('../src/settings-store.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'qwen-acp-settings-'))
  const configPath = join(directory, 'config.env')
  const command = 'custom-agent'
  const args = '["acp","--label","custom agent"]'
  writeFileSync(configPath, `AGENT_PROTOCOL=acp\nACP_COMMAND=${command}\nACP_ARGS='${args}'\n`)
  const store = createSettingsStore({
    configDir: directory, clientDir: join(directory, 'client'), env: {},
  })
  let settings = store.load()
  let saves = 0
  let ready = true
  const runtime = () => ({ gatewayConnected: true, backend: { connected: ready } })
  const handlers = {
    'settings-load': () => ({ settings, runtime: runtime(), skins: [], wakeShortcutRegistered: true }),
    'settings-runtime-status': runtime,
    'settings-detect-backends': () => ({ backends: [{
      id: 'acp', label: 'ACP Agent', ready, selected: settings.agentProtocol === 'acp',
      issues: ready ? [] : ['ACP_COMMAND 指定的命令不可用：custom-agent'],
    }] }),
    'updater-status': () => ({ phase: 'idle' }),
    'settings-save': (_event, draft) => {
      settings = store.save(draft)
      saves += 1
      return { settings, runtime: runtime(), wakeShortcutRegistered: true }
    },
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`qwen-audio-agent:${name}`, handler)
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: resolve(__dirname, '../src/preload.cjs'),
    },
  })
  const evaluate = source => window.webContents.executeJavaScript(source)
  const waitFor = condition => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = () => {
      if (${condition}) return resolve()
      if (Date.now() > deadline) return reject(new Error('ACP settings did not settle'))
      setTimeout(poll, 20)
    }
    poll()
  })`)
  const selected = `document.querySelector('input[name="agent-protocol"]:checked')?.value`
  try {
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await waitFor(`document.querySelector('#backend-picker-name').textContent === 'ACP Agent'`)
    assert.equal(await evaluate(selected), 'acp')
    // Saving unrelated settings, including after switching tabs, must preserve all ACP fields.
    for (const language of ['en', 'zh-CN']) {
      await evaluate(`(() => {
        document.querySelector('#backend-tab').click()
        document.querySelector('#app-tab').click()
        const field = document.querySelector('#desktop-language')
        field.value = '${language}'
        field.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`), false)
      const before = saves
      await evaluate(`document.querySelector('#settings-form').requestSubmit()`)
      await waitFor(`['success', 'notice'].includes(document.querySelector('#message').className) && ${selected} === 'acp'`)
      assert.equal(saves, before + 1)
      const persisted = parseEnv(readFileSync(configPath, 'utf8'))
      assert.equal(persisted.AGENT_PROTOCOL, 'acp')
      assert.equal(persisted.ACP_COMMAND, command)
      assert.equal(persisted.ACP_ARGS, args)
    }
    // A missing command is still represented, but must not be advertised as ready.
    ready = false
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await waitFor(`document.querySelector('#backend-picker-status').textContent.includes('配置')`)
    assert.equal(await evaluate(selected), 'acp')
    assert.equal(await evaluate(`document.querySelector('#backend-picker-status').classList.contains('ready')`), false)
    // Explicitly choosing frontend-only mode remains a real, persistable change.
    await evaluate(`(() => {
      document.querySelector('#backend-tab').click()
      document.querySelector('input[name="agent-protocol"][value="none"]').click()
    })()`)
    assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`), false)
    await evaluate(`document.querySelector('#settings-form').requestSubmit()`)
    await waitFor(`['success', 'notice'].includes(document.querySelector('#message').className) && ${selected} === 'none'`)
    assert.equal(store.load().agentProtocol, 'none')
    assert.equal(parseEnv(readFileSync(configPath, 'utf8')).ACP_ARGS, args)
  } finally {
    window.destroy()
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`qwen-audio-agent:${name}`)
    rmSync(directory, { recursive: true, force: true })
  }
}
