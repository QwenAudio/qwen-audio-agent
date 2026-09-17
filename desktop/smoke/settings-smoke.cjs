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
    // Exercise the actual dynamic form, including provider/model/language
    // switches. No user settings or provider API are accessed by this fixture.
    await evaluate(`(() => {
      window.setRealtimeField = (key, value) => {
        const field = document.querySelector('[data-setting="' + key + '"]')
        if (!field) throw new Error('Missing field: ' + key)
        field.value = value
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.dispatchEvent(new Event('change', { bubbles: true }))
      }
      window.selectFrontend = value => {
        document.querySelector('#realtime-provider > button').click()
        document.querySelector('#realtime-provider [data-value="' + value + '"]').click()
      }
      setRealtimeField('audioRealtimeVoice', 'audio-draft')
      document.querySelector('#realtime-provider > button').click()
      const search = document.querySelector('#realtime-provider input[type=search]')
      search.value = 'step'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    assert.equal(await evaluate(`document.querySelectorAll('#realtime-provider [role=option]').length`), 1)
    await evaluate(`document.querySelector('#realtime-provider [data-value=stepfun]').click()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=stepfunRealtimeModel]').value`), 'stepaudio-3-realtime-preview')
    assert.equal(await evaluate(`document.querySelector('[data-setting=audioRealtimeVoice]') === null`), true)
    await evaluate(`(() => {
      setRealtimeField('stepfunApiKey', 'test-step-key')
      setRealtimeField('stepfunRealtimeVoice', 'step-voice')
      selectFrontend('dashscope')
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=audioRealtimeVoice]').value`), 'audio-draft')
    await evaluate(`setRealtimeField('realtimeModel', 'qwen3.5-omni-plus-realtime')`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=omniRealtimeVoice]').value`), '')
    await evaluate(`(() => {
      setRealtimeField('omniRealtimeVoice', 'omni-draft')
      selectFrontend('speech-to-speech')
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=speechToSpeechRealtimeUrl]').value`), 'ws://127.0.0.1:8765/v1/realtime')
    assert.equal(await evaluate(`document.querySelector('#realtime-settings-panel select') === null`), true)
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel [data-realtime-slot]')].map(input => [input.dataset.realtimeSlot, input.disabled])`), [
      ['endpoint', false], ['credential', false], ['model', true], ['voice', true],
    ])
    // Local/remote ownership must never re-enable a provider's unsupported slots.
    for (const url of ['https://gateway.example', 'http://127.0.0.1:3101']) {
      await evaluate(`(() => {
        const field = document.querySelector('#gateway-url')
        field.value = ${JSON.stringify(url)}
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      assert.equal(await evaluate(`document.querySelector('[data-realtime-slot=model]').disabled && document.querySelector('[data-realtime-slot=voice]').disabled`), true)
    }
    await evaluate(`(() => {
      setRealtimeField('speechToSpeechRealtimeUrl', 'not-a-url')
      selectFrontend('stepfun')
      const language = document.querySelector('#desktop-language')
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=stepfunRealtimeVoice]').value`), 'step-voice')
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel label')].map(label => label.textContent)`), ['Service URL', 'API Key', 'Model', 'Voice'])
    assert.equal(await evaluate(`document.querySelector('label[for=realtime-provider-trigger]').textContent`), 'Provider')
    assert.equal(await evaluate(`document.querySelector('#settings-form').checkValidity()`), true, 'Inactive provider drafts cannot block the active provider')
    await evaluate(`(() => {
      const language = document.querySelector('#desktop-language')
      language.value = 'zh-CN'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await evaluate(`document.querySelector('#voice-tab').click()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-settings.png'), (await window.webContents.capturePage()).toPNG())
      await evaluate(`document.querySelector('#realtime-provider > button').click()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-picker.png'), (await window.webContents.capturePage()).toPNG())
      await evaluate(`document.querySelector('#realtime-provider > button').click()`)
      await evaluate(`selectFrontend('minicpm-o')`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-disabled-fields.png'), (await window.webContents.capturePage()).toPNG())
      await evaluate(`selectFrontend('stepfun')`)
    }
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#realtime-provider > button')).display`), 'flex')
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#realtime-provider-popover')).position`), 'absolute')
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel label')].map(label => label.textContent)`), ['服务地址', 'API Key', '模型', '音色'])
    assert.equal(await evaluate(`document.querySelector('label[for=realtime-provider-trigger]').textContent`), '供应商')
    assert.equal(await evaluate(`document.querySelector('#realtime-settings-panel details') === null`), true)
    await evaluate(`document.querySelector('#voice-tab').click()`)
    assert.equal(await evaluate(`(() => {
      const picker = document.querySelector('#realtime-provider-trigger').getBoundingClientRect()
      const endpoint = document.querySelector('[data-realtime-slot=endpoint]').getBoundingClientRect()
      return Math.abs(picker.left - endpoint.left) < 1 && Math.abs(picker.width - endpoint.width) < 1
    })()`), true, 'The provider selector aligns with the four field inputs')
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
