const assert = require('node:assert/strict')
const { resolve } = require('node:path')

// Exercise the real settings page and preload without starting a Gateway,
// accessing user configuration, or connecting to any external service.
module.exports = async function settingsSmoke({ BrowserWindow, ipcMain }) {
  const { parseSettings, clientSettingsPatch } = await import('../src/settings-config.mjs')
  const { parseDesktopGatewayInput } = await import('../src/gateway-connection.mjs')
  const { encodeGatewayPairingCode, encodeGatewayBrowserPairingCode } = await import('../../shared/gateway/remote-access.mjs')
  const { createRealtimeModelCatalogs } = await import('../../shared/realtime-model-catalog.mjs')
  const realtimeModelCatalogs = createRealtimeModelCatalogs({
    providers: { dashscope: { models: {
      'private-audio': { label: 'Private Audio', api: 'audio', voice: null },
      'private-omni': { label: 'Private Omni', api: 'omni', voice: 'Ethan' },
    } } },
  })
  let realtimeModelCatalogError = ''
  let realtimeConfigurationPending = false
  const modelCatalogStatus = () => ({
    realtimeModelCatalogs: realtimeModelCatalogError ? null : realtimeModelCatalogs,
    realtimeModelCatalogError,
    realtimeConfigurationPending,
  })
  let settings = { ...parseSettings('', {}), agentProtocol: 'qwen' }
  let saves = 0
  let runtimeRequests = 0
  let liveModelProfile = null
  const runtime = () => ({
    gatewayConnected: true, gatewayUrl: settings.gatewayUrl,
    realtimeProvider: liveModelProfile ? 'dashscope' : 'speech-to-speech',
    realtimeModel: liveModelProfile?.id || 'default', realtimeModelProfile: liveModelProfile, voiceConfigured: true,
    backend: { protocol: 'qwen', label: 'Qwen Code', connected: true },
  })
  const handlers = {
    'settings-load': () => ({ settings, ...modelCatalogStatus(), runtime: runtime(), skins: [], wakeShortcutRegistered: true }),
    'settings-runtime-status': () => { runtimeRequests += 1; return runtime() },
    'settings-detect-backends': () => ({ backends: [{
      id: 'qwen', label: 'Qwen Code', ready: true, selected: true,
      onboarding: { configuration: { required: true, status: 'unauthenticated' } },
    }] }),
    'updater-status': () => ({ phase: 'idle' }),
    'settings-save': (_event, draft) => {
      assert.equal('realtimeModelCatalogs' in draft, false, 'Read-only catalogs must not be submitted as settings')
      assert.equal('realtimeModelCatalogError' in draft, false)
      assert.equal('realtimeConfigurationPending' in draft, false)
      const target = parseDesktopGatewayInput(draft.gatewayUrl)
      settings = { ...settings, ...(target.remote ? clientSettingsPatch(draft) : draft), gatewayUrl: target.origin }
      saves += 1
      realtimeConfigurationPending = false
      return { settings, ...modelCatalogStatus(), runtime: runtime(), wakeShortcutRegistered: true }
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
    assert.deepEqual(await evaluate(`(() => {
      const model = document.querySelector('[data-setting=realtimeModel]')
      return { tag: model.tagName, registered: [...model.options].filter(option => option.value.startsWith('private-')).map(option => option.textContent),
        profile: !!document.querySelector('[data-realtime-slot=profile]') }
    })()`), { tag: 'SELECT', registered: ['Private Audio', 'Private Omni'], profile: false })
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
      setRealtimeField('realtimeVoice', 'audio-draft')
      document.querySelector('#realtime-provider > button').click()
      const search = document.querySelector('#realtime-provider input[type=search]')
      search.value = 'step'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    assert.equal(await evaluate(`document.querySelectorAll('#realtime-provider [role=option]').length`), 1)
    await evaluate(`document.querySelector('#realtime-provider [data-value=stepfun]').click()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').value`), 'stepaudio-3-realtime-preview')
    assert.equal(await evaluate(`[...document.querySelector('[data-setting=realtimeModel]').options].some(option => option.value.startsWith('private-'))`), false)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeApiKey]').value`), '')
    await evaluate(`(() => {
      setRealtimeField('realtimeApiKey', 'test-step-key')
      setRealtimeField('realtimeVoice', 'step-voice')
      selectFrontend('gpt-live-1')
    })()`)
    // GPT-Live 1 shows its own defaults and takes no other provider's key.
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').value`), 'gpt-live-1')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeUrl]').value`), 'wss://api.openai.com/v1/live/sessions')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeApiKey]').value`), '')
    await evaluate(`selectFrontend('dashscope')`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), 'audio-draft')
    await evaluate(`setRealtimeField('realtimeModel', 'private-audio')`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), '')
    await evaluate(`setRealtimeField('realtimeModel', 'private-omni')`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), '')
    await evaluate(`(() => {
      setRealtimeField('realtimeVoice', 'omni-draft')
      selectFrontend('speech-to-speech')
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeUrl]').value`), 'ws://127.0.0.1:8765/v1/realtime')
    assert.equal(await evaluate(`document.querySelector('#realtime-settings-panel select') === null`), true)
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel [data-realtime-slot]')].map(input => [input.dataset.realtimeSlot, input.disabled])`), [
      ['model', true], ['credential', false], ['endpoint', false], ['voice', true],
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
      setRealtimeField('realtimeUrl', 'not-a-url')
      selectFrontend('stepfun')
      const language = document.querySelector('#desktop-language')
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), 'step-voice')
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel label')].map(label => label.textContent)`), ['Model', 'API Key', 'Service URL', 'Voice'])
    assert.equal(await evaluate(`document.querySelector('label[for=realtime-provider-trigger]').textContent`), 'Provider')
    assert.equal(await evaluate(`document.querySelector('#settings-form').checkValidity()`), true, 'Inactive provider drafts cannot block the active provider')
    await evaluate(`selectFrontend('dashscope')`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').value`), 'private-omni')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), 'omni-draft')
    await evaluate(`selectFrontend('stepfun')`)
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
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#realtime-settings-panel label')].map(label => label.textContent)`), ['模型', 'API Key', '服务地址', '音色'])
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
    liveModelProfile = { id: 'private-omni', label: 'Private Omni Runtime', family: 'omni' }
    await evaluate(`(() => {
      selectFrontend('dashscope')
      setRealtimeField('realtimeModel', 'private-audio')
      setRealtimeField('realtimeVoice', 'audio-saved')
      setRealtimeField('realtimeModel', 'private-omni')
      setRealtimeField('realtimeVoice', '')
      document.querySelector('#settings-form').requestSubmit()
    })()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#message').className === 'success') return resolve()
        if (Date.now() > deadline) return reject(new Error('Registered model settings were not applied'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, links.length + 1)
    assert.equal(settings.realtimeModel, 'private-omni')
    assert.equal(settings.realtimeVoice, '')
    assert.match(await evaluate(`document.querySelector('#current-realtime').textContent`), /^Private Omni Runtime/)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true,
      'The save response must preserve the read-only catalog snapshot')
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === 'private-omni') return resolve()
        if (Date.now() > deadline) return reject(new Error('Registered model settings were not restored'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), '')
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await evaluate(`document.querySelector('#voice-tab').click()`)
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-registered-model.png'), (await window.webContents.capturePage()).toPNG())
    }

    // A removed registry entry must remain visible and block saving. Native
    // validation must reveal the Voice tab before trying to focus its selector.
    settings = { ...settings, realtimeModel: 'removed-private-model' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === 'removed-private-model') return resolve()
        if (Date.now() > deadline) return reject(new Error('Unregistered model was silently changed'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.deepEqual(await evaluate(`(() => {
      const model = document.querySelector('[data-setting=realtimeModel]')
      document.querySelector('#app-tab').click()
      document.querySelector('#settings-form').requestSubmit()
      return { value: model.value, error: model.validationMessage.includes('frontend-models.json'),
        selected: model.selectedOptions[0].textContent,
        voiceVisible: !document.querySelector('#voice-settings').hidden, focused: document.activeElement === model }
    })()`), { value: 'removed-private-model', error: true, selected: 'removed-private-model（未登记）', voiceVisible: true, focused: true })
    assert.equal(saves, links.length + 1, 'Unregistered models must not reach settings-save')
    assert.doesNotMatch(rendererMessages.join('\n'), /not focusable/)
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-unregistered-model.png'), (await window.webContents.capturePage()).toPNG())
    }

    realtimeModelCatalogError = 'Invalid JSON in frontend model catalog /example/frontend-models.json'
    settings = { ...settings, gatewayUrl: 'https://gateway.example' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#realtime-model-catalog-error').textContent.includes('Invalid JSON')) return resolve()
        if (Date.now() > deadline) return reject(new Error('Catalog failure prevented settings from loading'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('#gateway-url').value`), 'https://gateway.example')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').disabled`), true)
    assert.equal(await evaluate(`document.querySelector('#settings-form').checkValidity()`), true,
      'Unavailable local catalogs must not block remote preferences')
    await evaluate(`(() => {
      const language = document.querySelector('#desktop-language')
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('#settings-form').requestSubmit()
    })()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#message').className === 'success') return resolve()
        if (Date.now() > deadline) return reject(new Error('Catalog failure prevented saving remote preferences'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, links.length + 2)
    assert.equal(settings.language, 'en')
    assert.match(await evaluate(`document.querySelector('#realtime-model-catalog-error').textContent`), /^Cannot load the local model catalog/)
    const requestsBeforeRefresh = runtimeRequests
    await evaluate(`new Promise(resolve => setTimeout(resolve, 2100))`)
    assert.ok(runtimeRequests > requestsBeforeRefresh)
    assert.equal(await evaluate(`document.querySelector('#realtime-model-catalog-error').hidden`), false)
    assert.match(await evaluate(`document.querySelector('#realtime-model-catalog-error').textContent`), /Invalid JSON/)
    assert.deepEqual(await evaluate(`(() => {
      const gateway = document.querySelector('#gateway-url')
      gateway.value = 'http://localhost:3101'
      gateway.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('#app-tab').click()
      document.querySelector('#settings-form').requestSubmit()
      const model = document.querySelector('[data-setting=realtimeModel]')
      return { enabled: !model.disabled, error: model.validationMessage,
        voiceVisible: !document.querySelector('#voice-settings').hidden }
    })()`), { enabled: true, error: 'Model catalog is unavailable. Fix its configuration and reopen Settings.', voiceVisible: true })
    assert.equal(saves, links.length + 2, 'Catalog failure must still prevent local model configuration')
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-catalog-error.png'), (await window.webContents.capturePage()).toPNG())
    }

    // Metadata-only catalog edits have no editable-field fingerprint delta.
    // A main-process pending signal must still allow applying them locally.
    realtimeModelCatalogError = ''
    realtimeConfigurationPending = true
    settings = { ...settings, gatewayUrl: 'http://localhost:3101', realtimeModel: 'private-omni', agentProtocol: 'none' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === 'private-omni') return resolve()
        if (Date.now() > deadline) return reject(new Error('Pending catalog settings were not loaded'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`), false,
      'A pending local catalog must be applicable without changing editable fields')
    await evaluate(`document.querySelector('#settings-form').requestSubmit()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#message').className === 'success') return resolve()
        if (Date.now() > deadline) return reject(new Error('Pending catalog settings were not applied'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, links.length + 3)
    assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`), true,
      'The save response clears pending state and disables unchanged Apply')
    realtimeConfigurationPending = true
    settings = { ...settings, gatewayUrl: 'https://gateway.example' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#gateway-url').value === 'https://gateway.example') return resolve()
        if (Date.now() > deadline) return reject(new Error('Remote settings were not loaded'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`), true,
      'Local catalog pending state must not enable Apply for an unchanged remote client')
    assert.deepEqual(await evaluate(`(() => {
      const language = document.querySelector('#desktop-language')
      language.value = 'zh-CN'
      language.dispatchEvent(new Event('change', { bubbles: true }))
      const changed = !document.querySelector('button[type=submit]').disabled
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
      return { changed, unchanged: document.querySelector('button[type=submit]').disabled }
    })()`), { changed: true, unchanged: true })
  } catch (error) {
    throw new Error(`${error.stack || error.message}\n${rendererMessages.join('\n')}`, { cause: error })
  } finally {
    window.destroy()
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`qwen-audio-agent:${name}`)
  }
}
