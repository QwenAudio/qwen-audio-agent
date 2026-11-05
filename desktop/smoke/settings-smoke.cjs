const assert = require('node:assert/strict')
const { resolve } = require('node:path')

// Exercise the real settings page and preload without starting a Gateway,
// accessing user configuration, or connecting to any external service.
module.exports = async function settingsSmoke({ BrowserWindow, ipcMain }) {
  const { parseSettings, clientSettingsPatch } = await import('../src/settings-config.mjs')
  const { parseDesktopGatewayInput } = await import('../src/gateway-connection.mjs')
  const { encodeGatewayPairingCode, encodeGatewayBrowserPairingCode } = await import('../../shared/gateway/remote-access.mjs')
  const {
    BUILTIN_REALTIME_MODEL_CATALOGS: realtimeModelCatalogs,
    DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL: flashModel,
    DASHSCOPE_OMNI_FLASH_REALTIME_MODEL: omniModel,
  } = await import('../../shared/realtime-model-catalog.mjs')
  let catalogSnapshot = realtimeModelCatalogs
  let realtimeConfigurationPending = false
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
    'settings-load': () => ({
      settings, realtimeModelCatalogs: catalogSnapshot, realtimeConfigurationPending,
      runtime: runtime(), skins: [], wakeShortcutRegistered: true,
    }),
    'settings-runtime-status': () => { runtimeRequests += 1; return runtime() },
    'settings-detect-backends': () => ({ backends: [{
      id: 'qwen', label: 'Qwen Code', ready: true, selected: true,
      onboarding: { configuration: { required: true, status: 'unauthenticated' } },
    }] }),
    'updater-status': () => ({ phase: 'idle' }),
    'settings-save': (_event, draft) => {
      assert.equal('realtimeModelCatalogs' in draft, false, 'Read-only catalogs must not be submitted as settings')
      assert.equal('realtimeConfigurationPending' in draft, false)
      const target = parseDesktopGatewayInput(draft.gatewayUrl)
      settings = { ...settings, ...(target.remote ? clientSettingsPatch(draft) : draft), gatewayUrl: target.origin }
      saves += 1
      realtimeConfigurationPending = false
      return {
        settings, realtimeModelCatalogs: catalogSnapshot, realtimeConfigurationPending,
        runtime: runtime(), wakeShortcutRegistered: true,
      }
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
      return { tag: model.tagName, flash: [...model.options].find(option => option.value === ${JSON.stringify(flashModel)})?.textContent,
        profile: !!document.querySelector('[data-realtime-slot=profile]') }
    })()`), { tag: 'SELECT', flash: 'Qwen Audio 3.1 Realtime Flash', profile: false })
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
    assert.equal(await evaluate(`[...document.querySelector('[data-setting=realtimeModel]').options].some(option => option.value === ${JSON.stringify(flashModel)})`), false)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeApiKey]').value`), '')
    await evaluate(`(() => {
      setRealtimeField('realtimeApiKey', 'test-step-key')
      setRealtimeField('realtimeVoice', 'step-voice')
      selectFrontend('dashscope')
    })()`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), 'audio-draft')
    await evaluate(`setRealtimeField('realtimeModel', ${JSON.stringify(flashModel)})`)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').value`), '')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeVoice]').placeholder`), 'longanqian_v3.1')
    await evaluate(`setRealtimeField('realtimeModel', ${JSON.stringify(omniModel)})`)
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
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').value`), omniModel)
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
    liveModelProfile = realtimeModelCatalogs.dashscope.profiles.find(profile => profile.id === flashModel)
    await evaluate(`(() => {
      selectFrontend('dashscope')
      setRealtimeField('realtimeModel', ${JSON.stringify(omniModel)})
      setRealtimeField('realtimeVoice', 'omni-saved')
      setRealtimeField('realtimeModel', ${JSON.stringify(flashModel)})
      setRealtimeField('realtimeVoice', '')
      document.querySelector('#settings-form').requestSubmit()
    })()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#message').className === 'success') return resolve()
        if (Date.now() > deadline) return reject(new Error('Supported model settings were not applied'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, links.length + 1)
    assert.equal(settings.realtimeModel, flashModel)
    assert.equal(settings.realtimeVoice, '')
    assert.match(await evaluate(`document.querySelector('#current-realtime').textContent`), /^Qwen Audio 3\.1 Flash/)
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').checkValidity()`), true,
      'The save response must preserve the read-only catalog snapshot')
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === ${JSON.stringify(flashModel)}) return resolve()
        if (Date.now() > deadline) return reject(new Error('Supported model settings were not restored'))
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
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-supported-model.png'), (await window.webContents.capturePage()).toPNG())
    }

    // An unsupported saved model must remain visible and block saving. Native
    // validation must reveal the Voice tab before trying to focus its selector.
    settings = { ...settings, realtimeModel: 'unsupported-model' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === 'unsupported-model') return resolve()
        if (Date.now() > deadline) return reject(new Error('Unsupported model was silently changed'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.deepEqual(await evaluate(`(() => {
      const model = document.querySelector('[data-setting=realtimeModel]')
      document.querySelector('#app-tab').click()
      document.querySelector('#settings-form').requestSubmit()
      return { value: model.value, error: model.validationMessage.includes('模型不受支持'),
        selected: model.selectedOptions[0].textContent,
        voiceVisible: !document.querySelector('#voice-settings').hidden, focused: document.activeElement === model }
    })()`), { value: 'unsupported-model', error: true, selected: 'unsupported-model（不支持）', voiceVisible: true, focused: true })
    assert.equal(saves, links.length + 1, 'Unsupported models must not reach settings-save')
    assert.doesNotMatch(rendererMessages.join('\n'), /not focusable/)
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-unsupported-model.png'), (await window.webContents.capturePage()).toPNG())
    }

    settings = { ...settings, gatewayUrl: 'https://gateway.example' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#gateway-url').value === 'https://gateway.example') return resolve()
        if (Date.now() > deadline) return reject(new Error('Unsupported local model prevented remote settings from loading'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(await evaluate(`document.querySelector('#gateway-url').value`), 'https://gateway.example')
    assert.equal(await evaluate(`document.querySelector('[data-setting=realtimeModel]').disabled`), true)
    assert.equal(await evaluate(`document.querySelector('#settings-form').checkValidity()`), true,
      'Unsupported local models must not block remote preferences')
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
        if (Date.now() > deadline) return reject(new Error('Unsupported local model prevented saving remote preferences'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, links.length + 2)
    assert.equal(settings.language, 'en')
    const requestsBeforeRefresh = runtimeRequests
    await evaluate(`new Promise(resolve => setTimeout(resolve, 2100))`)
    assert.ok(runtimeRequests > requestsBeforeRefresh)
    assert.deepEqual(await evaluate(`(() => {
      const gateway = document.querySelector('#gateway-url')
      gateway.value = 'http://localhost:3101'
      gateway.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('#app-tab').click()
      document.querySelector('#settings-form').requestSubmit()
      const model = document.querySelector('[data-setting=realtimeModel]')
      return { enabled: !model.disabled, error: model.validationMessage,
        voiceVisible: !document.querySelector('#voice-settings').hidden }
    })()`), { enabled: true, error: 'Model is not supported. Select a listed model.', voiceVisible: true })
    assert.equal(saves, links.length + 2, 'Unsupported models must still prevent local model configuration')
    if (process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR) {
      const { writeFile } = require('node:fs/promises')
      await new Promise(resolve => setTimeout(resolve, 150))
      await writeFile(resolve(process.env.QWAUDIO_SMOKE_SCREENSHOT_DIR, 'voice-unsupported-model-en.png'), (await window.webContents.capturePage()).toPNG())
    }

    // An application update can change model defaults without changing fields.
    // A main-process pending signal must still allow applying them locally.
    realtimeConfigurationPending = true
    settings = { ...settings, gatewayUrl: 'http://localhost:3101', realtimeModel: flashModel, agentProtocol: 'none' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === ${JSON.stringify(flashModel)}) return resolve()
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

    // A missing IPC snapshot blocks only local model settings, without reviving
    // the obsolete user-file error state or preventing remote client changes.
    catalogSnapshot = undefined
    realtimeConfigurationPending = false
    settings = { ...settings, gatewayUrl: 'http://localhost:3101' }
    await window.loadFile(resolve(__dirname, '../src/settings.html'))
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('[data-setting=realtimeModel]')?.value === ${JSON.stringify(flashModel)}) return resolve()
        if (Date.now() > deadline) return reject(new Error('Missing snapshot silently changed the selected model'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    const savesBeforeMissingSnapshot = saves
    assert.deepEqual(await evaluate(`(() => {
      const language = document.querySelector('#desktop-language')
      language.value = 'zh-CN'
      language.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('#settings-form').requestSubmit()
      const model = document.querySelector('[data-setting=realtimeModel]')
      return { value: model.value, invalid: !model.checkValidity(), error: model.validationMessage,
        options: model.options.length, oldNotice: !!document.querySelector('#realtime-model-catalog-error') }
    })()`), {
      value: flashModel, invalid: true, error: '模型目录不可用，请重新打开设置或重启应用', options: 1, oldNotice: false,
    })
    assert.equal(saves, savesBeforeMissingSnapshot)
    assert.equal(await evaluate(`(() => {
      const gateway = document.querySelector('#gateway-url')
      gateway.value = 'https://gateway.example'
      gateway.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelector('#settings-form').checkValidity()
        && document.querySelector('[data-setting=realtimeModel]').disabled
        && !document.querySelector('button[type=submit]').disabled
    })()`), true, 'A missing local model snapshot must not block remote client settings')
    await evaluate(`document.querySelector('#settings-form').requestSubmit()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        if (document.querySelector('#message').className === 'success') return resolve()
        if (Date.now() > deadline) return reject(new Error('Missing model snapshot prevented remote settings from saving'))
        setTimeout(poll, 20)
      }
      poll()
    })`)
    assert.equal(saves, savesBeforeMissingSnapshot + 1)
  } catch (error) {
    throw new Error(`${error.stack || error.message}\n${rendererMessages.join('\n')}`, { cause: error })
  } finally {
    window.destroy()
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`qwen-audio-agent:${name}`)
  }
}
