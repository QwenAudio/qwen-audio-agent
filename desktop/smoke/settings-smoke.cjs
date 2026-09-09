const assert = require('node:assert/strict')
const { resolve } = require('node:path')

// Exercise the real settings page and preload without starting a Gateway,
// accessing user configuration, or connecting to any external service.
module.exports = async function settingsSmoke({ BrowserWindow, ipcMain }) {
  const { parseSettings, clientSettingsPatch } = await import('../src/settings-config.mjs')
  const { parseDesktopGatewayInput } = await import('../src/gateway-connection.mjs')
  const { encodeGatewayPairingCode, encodeGatewayBrowserPairingCode } = await import('../../shared/gateway/remote-access.mjs')
  let settings = { ...parseSettings('', {}), agentProtocol: 'qwen' }
  let saves = 0
  const runtime = () => ({
    gatewayConnected: true, gatewayUrl: settings.gatewayUrl,
    realtimeProvider: 'speech-to-speech', realtimeModel: 'default', voiceConfigured: true,
    backend: { protocol: 'qwen', label: 'Qwen Code', connected: true },
  })
  const handlers = {
    'settings-load': () => ({ settings, runtime: runtime(), skins: [], wakeShortcutRegistered: true }),
    'settings-runtime-status': runtime,
    'settings-detect-backends': () => ({ backends: [{
      id: 'qwen', label: 'Qwen Code', ready: true, selected: true,
      onboarding: { configuration: { required: true, status: 'unauthenticated' } },
    }] }),
    'updater-status': () => ({ phase: 'idle' }),
    'settings-save': (_event, draft) => {
      const target = parseDesktopGatewayInput(draft.gatewayUrl)
      settings = { ...settings, ...(target.remote ? clientSettingsPatch(draft) : draft), gatewayUrl: target.origin }
      saves += 1
      return { settings, runtime: runtime(), wakeShortcutRegistered: true }
    },
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`qwen-audio-agent:${name}`, handler)
  }
  const window = new BrowserWindow({
    width: 650, height: 760, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: resolve(__dirname, '../src/preload.cjs'),
    },
  })
  const evaluate = source => window.webContents.executeJavaScript(source)
  const rendererMessages = []
  window.webContents.on('console-message', (_event, details) => {
    if (details.message) rendererMessages.push(details.message)
  })
  try {
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#gateway-url').value) return resolve()
        if (Date.now() > deadline) return reject(new Error('Settings did not load'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('#gateway-pairing-code') === null`), true)
    const legacyCode = { version: 1, gateway_url: 'https://gateway.example', pairing_code: 'test-code', expires_at: Date.now() + 60_000 }
    const links = [
      encodeGatewayPairingCode(legacyCode),
      encodeGatewayBrowserPairingCode(legacyCode),
      'https://gateway.example/c#d.AbCdEfGhIjKlMnOpQrStUv',
      'http://192.168.1.20:3101/c#d.AbCdEfGhIjKlMnOpQrStUv',
    ]
    for (const link of links) {
      const expectedOrigin = parseDesktopGatewayInput(link).origin
      assert.equal(await evaluate(`(() => {
        document.querySelector('#app-tab').click()
        const field = document.querySelector('#gateway-url')
        field.value = ${JSON.stringify(link)}
        field.dispatchEvent(new Event('input', { bubbles: true }))
        return field.checkValidity() && !document.querySelector('button[type=submit]').disabled
      })()`), true, 'A pairing URL must be submittable even without local backend authentication')
      await evaluate(`new Promise((resolve, reject) => {
        document.querySelector('#settings-form').requestSubmit()
        const deadline = Date.now() + 5000
        const poll = () => {
          if (document.querySelector('#gateway-url').value === ${JSON.stringify(expectedOrigin)}) return resolve()
          if (Date.now() > deadline) return reject(new Error('Settings were not applied'))
          setTimeout(poll, 20)
        }
        poll()
      })`)
    }
    assert.equal(saves, links.length)
    assert.equal(await evaluate(`document.querySelector('[data-local-gateway-settings]').hidden`), true)
    assert.equal(await evaluate(`document.querySelector('#current-backend').textContent.includes('待配置')`), false)
    assert.equal(await evaluate(`(() => {
      const field = document.querySelector('#gateway-url')
      field.value = 'http://localhost:3101'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return !document.querySelector('[data-local-gateway-settings]').hidden
        && !document.querySelector('button[type=submit]').disabled
    })()`), true, 'Switching to a local address restores local configuration controls')
  } catch (error) {
    throw new Error(`${error.message}\n${rendererMessages.join('\n')}`, { cause: error })
  } finally {
    window.destroy()
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`qwen-audio-agent:${name}`)
  }
}
