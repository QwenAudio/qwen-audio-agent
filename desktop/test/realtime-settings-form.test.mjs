import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REALTIME_PROVIDERS,
  REALTIME_SETTING_FIELDS,
  realtimeSettingsFromProfileState,
  realtimeSettingsProfileState,
  realtimeSettingsValues,
} from '../../shared/realtime-provider-definitions.mjs'
import { createRealtimeSettingsForm, realtimeSettingsFields } from '../src/realtime-settings-form.mjs'
import { BUILTIN_REALTIME_MODEL_CATALOGS, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL } from '../../shared/realtime-model-catalog.mjs'
import { normalizeSettings, parseSettings } from '../src/settings-config.mjs'
import { desktopTranslator } from '../src/i18n.mjs'

function formFixture(settings = {}, catalogs = BUILTIN_REALTIME_MODEL_CATALOGS, translate) {
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)])
  const document = {
    addEventListener() {},
    createElement(tagName) {
      const listeners = new Map()
      return {
        tagName, ownerDocument: document, dataset: {}, children: [], value: '', attributes: {},
        setAttribute(name, value) { this.attributes[name] = value },
        setCustomValidity(message) { this.validationMessage = message },
        addEventListener(type, listener) {
          listeners.set(type, [...listeners.get(type) || [], listener])
        },
        dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event) },
        append(...children) { this.children.push(...children) },
        replaceChildren(...children) { this.children = children },
        focus() { document.activeElement = this },
        querySelector(selector) {
          const key = selector.match(/\[data-setting="([^"]+)"\]/)?.[1]
          return descendants(this).find(node => node.dataset.setting === key)
        },
        get options() { return this.children },
      }
    },
  }
  const panel = document.createElement('div')
  const pickerRoot = document.createElement('div')
  const changes = []
  const form = createRealtimeSettingsForm({
    pickerRoot, panel, translate,
    onChange() { changes.push(form.values()) }, openExternal() {},
  })
  form.load(settings, catalogs)
  const field = key => descendants(panel).find(node => node.dataset.setting === key)
  const slot = name => descendants(panel).find(node => node.dataset.realtimeSlot === name)
  const selectProvider = provider => descendants(pickerRoot)
    .find(node => node.dataset.value === provider).dispatchEvent({ type: 'click' })
  const change = (key, value) => {
    const input = field(key)
    input.value = value
    input.dispatchEvent({ type: 'input' })
    input.dispatchEvent({ type: 'change' })
  }
  return { document, panel, form, field, slot, changes, change, selectProvider }
}

test('all providers share canonical bindings and lossless active drafts', () => {
  const keys = REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.key))
  assert.deepEqual(new Set(REALTIME_SETTING_FIELDS), new Set(['realtimeProvider', ...keys]))
  for (const provider of REALTIME_PROVIDERS) {
    assert.ok(provider.settings.some(field => field.key === provider.requiredConfiguration.field))
    const draft = realtimeSettingsValues({ realtimeProvider: provider.key })
    for (const field of provider.settings) draft[field.key] = 'test-' + field.key
    assert.deepEqual(realtimeSettingsFromProfileState(realtimeSettingsProfileState(draft)), draft)
  }
})

test('model families share one override and expose their own default voice', () => {
  const provider = REALTIME_PROVIDERS.find(provider => provider.key === 'dashscope')
  const values = realtimeSettingsValues({ realtimeVoice: 'my-voice' })
  const voice = () => realtimeSettingsFields(provider, values).filter(field => field.label === '音色')
  assert.equal(voice()[0].key, 'realtimeVoice')
  assert.ok(voice()[0].placeholder)
  values.realtimeModel = 'qwen3.5-omni-plus-realtime'
  assert.equal(voice()[0].key, 'realtimeVoice')
  assert.ok(voice()[0].placeholder)
  values.realtimeModel = 'future-model'
  assert.equal(voice()[0].disabled, true)
  assert.equal(voice()[0].key, undefined)
  assert.equal(values.realtimeVoice, 'my-voice')
  assert.equal(realtimeSettingsValues().realtimeVoice, '')
})

test('every provider presents the same four slots in the same order', () => {
  for (const provider of REALTIME_PROVIDERS) {
    const fields = realtimeSettingsFields(provider, realtimeSettingsValues())
    assert.deepEqual(fields.map(field => field.label), ['模型', 'API Key', '服务地址', '音色'])
    assert.deepEqual(fields.map(field => field.slot), ['model', 'credential', 'endpoint', 'voice'])
  }
})

test('Omni 3.8 uses the existing model, endpoint and voice settings', () => {
  const provider = REALTIME_PROVIDERS.find(provider => provider.key === 'dashscope')
  const values = realtimeSettingsValues({
    realtimeModel: 'qwen3.8-omni-flash-realtime',
    realtimeUrl: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  })
  const fields = realtimeSettingsFields(provider, values)
  assert.equal(fields.length, 4)
  assert.equal(fields[0].key, 'realtimeModel')
  assert.equal(fields[2].key, 'realtimeUrl')
  assert.equal(fields[3].key, 'realtimeVoice')
  assert.equal(fields[3].placeholder, 'Tina')
  assert.deepEqual(realtimeSettingsFromProfileState(realtimeSettingsProfileState(values)), values)
})

test('Audio 3.1 is rendered as a model option with the Audio family voice binding', () => {
  const { form, field } = formFixture({ realtimeModel: 'qwen-audio-3.1-realtime-plus' })
  const model = field('realtimeModel')
  assert.equal(model.value, 'qwen-audio-3.1-realtime-plus')
  assert.equal(model.options.find(option => option.value === model.value)?.textContent, 'Qwen Audio 3.1 Realtime Plus')
  const voice = field('realtimeVoice')
  assert.equal(voice.dataset.setting, 'realtimeVoice')
  assert.equal(voice.placeholder, 'longanqian_v3.1')
  assert.equal(voice.value, '')
  assert.equal(form.values().realtimeVoice, '')

  form.load({
    realtimeModel: 'qwen-audio-3.1-realtime-plus',
    realtimeVoice: 'custom-audio',
  }, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.equal(field('realtimeVoice').value, 'custom-audio')
  assert.equal(form.values().realtimeVoice, 'custom-audio')
  form.load({}, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.equal(form.values().realtimeModel, 'qwen-audio-3.1-realtime-plus')
  assert.equal(field('realtimeVoice').placeholder, 'longanqian_v3.1')
})

test('built-in Flash renders from the fixed IPC catalog without mutating other form snapshots', () => {
  const plus = 'qwen-audio-3.1-realtime-plus'
  const flash = DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL
  const catalogs = BUILTIN_REALTIME_MODEL_CATALOGS
  // Desktop receives a JSON snapshot across IPC, not the registry's live objects.
  const snapshot = JSON.parse(JSON.stringify(catalogs))
  const current = formFixture({ realtimeModel: plus, realtimeVoice: 'explicit-voice' }, snapshot)
  const defaults = formFixture({ realtimeModel: plus })
  const option = (fixture, id) => fixture.field('realtimeModel').options.find(item => item.value === id)
  assert.equal(option(current, plus).textContent, 'Qwen Audio 3.1 Realtime Plus')
  assert.equal(current.field('realtimeVoice').placeholder, 'longanqian_v3.1')
  assert.equal(current.field('realtimeVoice').value, 'explicit-voice')
  assert.equal(option(defaults, plus).textContent, 'Qwen Audio 3.1 Realtime Plus')
  assert.equal(option(defaults, flash).textContent, 'Qwen Audio 3.1 Realtime Flash')

  current.change('realtimeModel', flash)
  assert.equal(option(current, flash).textContent, 'Qwen Audio 3.1 Realtime Flash')
  assert.equal(current.field('realtimeModel').validationMessage, '')
  assert.equal(current.field('realtimeVoice').placeholder, 'longanqian_v3.1')
  assert.equal(current.form.values().realtimeVoice, '')
  current.form.render()
  assert.equal(current.field('realtimeModel').value, flash)
  assert.equal(current.field('realtimeVoice').placeholder, 'longanqian_v3.1')
  current.change('realtimeModel', plus)
  assert.equal(current.field('realtimeVoice').placeholder, 'longanqian_v3.1')
  assert.equal(current.form.values().realtimeVoice, '')
  assert.deepEqual(snapshot, catalogs)
  assert.equal('turnDetection' in current.form.values(), false)
})

test('model changes reset voice and provider drafts remain isolated in memory', () => {
  const { form, field, change, selectProvider, changes } = formFixture({
    realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, realtimeVoice: 'audio-draft', realtimeApiKey: 'dashscope-only',
  })
  assert.equal(field('realtimeModel').tagName, 'select')
  assert.equal(field('realtimeModel').value, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
  assert.equal(field('realtimeModel').validationMessage, '')
  assert.equal(field('realtimeModel').options.find(option => option.value === DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL).textContent, 'Qwen Audio 3.1 Realtime Flash')
  assert.ok(field('realtimeModel').options.some(option => option.value === 'qwen-audio-3.1-realtime-plus'))
  assert.equal(field('realtimeVoice').value, 'audio-draft')
  change('realtimeModel', 'qwen3.5-omni-plus-realtime')
  assert.equal(field('realtimeVoice').value, '')
  assert.equal(field('realtimeVoice').placeholder, 'Ethan')
  assert.equal(changes.at(-1).realtimeModel, 'qwen3.5-omni-plus-realtime')
  change('realtimeVoice', '')
  selectProvider('stepfun')
  assert.equal(field('realtimeApiKey').value, '')
  assert.equal(field('realtimeUrl').value, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(field('realtimeModel').options.some(option => option.value === 'qwen3.5-omni-plus-realtime'), false)
  change('realtimeVoice', 'step-draft')
  selectProvider('dashscope')
  assert.equal(field('realtimeModel').value, 'qwen3.5-omni-plus-realtime')
  assert.equal(field('realtimeVoice').value, '')
  change('realtimeModel', DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
  assert.equal(field('realtimeVoice').value, '')
  assert.equal(form.values().realtimeApiKey, 'dashscope-only')
  selectProvider('stepfun')
  assert.equal(field('realtimeVoice').value, 'step-draft')
  assert.equal('realtimeModelCatalogs' in form.values(), false)
})

test('non-DashScope defaults are shown without creating a voice override', () => {
  const { form, field, selectProvider } = formFixture({ realtimeProvider: 'doubao-seeduplex' })
  assert.equal(field('realtimeVoice').placeholder, 'zh_female_vv_jupiter_bigtts')
  assert.equal(field('realtimeVoice').value, '')
  assert.equal(form.values().realtimeVoice, '')
  selectProvider('gpt-live')
  assert.equal(field('realtimeModel').value, BUILTIN_REALTIME_MODEL_CATALOGS['gpt-live'].defaultModel)
  assert.ok(field('realtimeVoice').placeholder)
  assert.equal(field('realtimeVoice').value, '')
})

test('unsupported saved models stay selected, literal and invalid instead of changing to a default', () => {
  const unknown = '<img src=x onerror=alert(1)>custom-model'
  const { form, field, slot, change, selectProvider } = formFixture({ realtimeModel: unknown })
  const model = field('realtimeModel')
  assert.equal(model.value, unknown)
  const option = model.options.find(option => option.value === unknown)
  assert.ok(option.textContent.startsWith(unknown))
  assert.equal(option.children.length, 0)
  assert.match(model.validationMessage, /模型不受支持/)
  assert.doesNotMatch(model.validationMessage, /frontend-models\.json/)
  assert.equal(slot('voice').disabled, true)
  assert.equal(form.values().realtimeModel, unknown)
  selectProvider('stepfun')
  assert.equal(field('realtimeModel').validationMessage, '')
  selectProvider('dashscope')
  assert.equal(field('realtimeModel').value, unknown)
  change('realtimeModel', 'qwen3.5-omni-plus-realtime')
  assert.equal(field('realtimeModel').validationMessage, '')
  assert.equal(slot('voice').dataset.setting, 'realtimeVoice')
})

test('catalog snapshots stay isolated and language rerender preserves supported models and drafts', () => {
  let translate = desktopTranslator('zh-CN')
  const current = formFixture({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, realtimeVoice: 'my-voice' },
    JSON.parse(JSON.stringify(BUILTIN_REALTIME_MODEL_CATALOGS)), text => translate(text))
  const builtins = formFixture({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL })
  assert.equal(current.field('realtimeModel').validationMessage, '')
  assert.equal(builtins.field('realtimeModel').validationMessage, '')
  translate = desktopTranslator('en')
  current.form.render()
  assert.equal(current.field('realtimeModel').value, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
  assert.equal(current.field('realtimeModel').validationMessage, '')
  assert.equal(current.field('realtimeVoice').value, 'my-voice')
  assert.equal(current.panel.children[0].children[0].textContent, 'Model')
  current.form.load({ realtimeModel: 'unsupported-model' }, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.match(current.field('realtimeModel').validationMessage, /^Model is not supported/)
  current.form.load({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL }, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.equal(current.field('realtimeModel').validationMessage, '')
})

test('an unavailable IPC catalog preserves the form until the fixed snapshot is restored', () => {
  const { form, field, slot, selectProvider } = formFixture()
  for (const snapshot of [undefined, null, {}, { dashscope: { profiles: [] } }]) {
    form.load({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, realtimeVoice: 'saved-voice' }, snapshot)
    assert.equal(field('realtimeModel').value, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
    assert.equal(field('realtimeModel').options[0].textContent, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL + '（目录不可用）')
    assert.match(field('realtimeModel').validationMessage, /目录不可用/)
    assert.equal(form.values().realtimeVoice, 'saved-voice')
    form.render()
    assert.match(field('realtimeModel').validationMessage, /目录不可用/)
    selectProvider('stepfun')
    assert.match(field('realtimeModel').validationMessage, /目录不可用/)
    for (const provider of ['minicpm-o', 'speech-to-speech']) {
      selectProvider(provider)
      assert.equal(slot('model').disabled, true)
      assert.equal(slot('model').validationMessage, undefined)
      assert.equal(slot('endpoint').disabled, undefined)
    }
  }
  form.load({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL }, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.equal(field('realtimeModel').validationMessage, '')
})

test('missing provider snapshots do not block providers whose model snapshots are present', () => {
  const { field, selectProvider } = formFixture({}, { stepfun: BUILTIN_REALTIME_MODEL_CATALOGS.stepfun })
  assert.match(field('realtimeModel').validationMessage, /目录不可用/)
  selectProvider('stepfun')
  assert.equal(field('realtimeModel').validationMessage, '')
  selectProvider('dashscope')
  assert.match(field('realtimeModel').validationMessage, /目录不可用/)
})

test('service-owned model and voice rows stay visible but have no writable binding', () => {
  for (const provider of REALTIME_PROVIDERS.filter(provider => !provider.settings.some(field => field.type === 'model'))) {
    const fields = realtimeSettingsFields(provider, realtimeSettingsValues())
    for (const field of fields.filter(field => ['model', 'voice'].includes(field.slot))) {
      assert.equal(field.disabled, true)
      assert.equal(field.key, undefined)
    }
    assert.equal(fields.find(field => field.slot === 'endpoint').disabled, false)
    assert.equal(fields.find(field => field.slot === 'credential').disabled, false)
  }
})

test('a provider without a credential binding gets a disabled API Key row', () => {
  const provider = { key: 'no-auth', settings: [] }
  const fields = realtimeSettingsFields(provider, {})
  assert.equal(fields[1].label, 'API Key')
  assert.equal(fields[1].disabled, true)
  assert.equal(fields[1].key, undefined)
})

test('invalid in-memory endpoint drafts do not leak into another selected provider', () => {
  const { form, selectProvider, change } = formFixture({ realtimeProvider: 'speech-to-speech' })
  change('realtimeUrl', 'not-a-url')
  selectProvider('stepfun')
  assert.equal(normalizeSettings(form.values()).realtimeUrl, 'wss://api.stepfun.com/v1/realtime')
  selectProvider('speech-to-speech')
  assert.throws(() => normalizeSettings(form.values()), /Invalid URL/)
})

test('explicit empty runtime fields override fallback values', () => {
  const settings = parseSettings('QWEN_AUDIO_REALTIME_API_KEY=\nQWEN_AUDIO_REALTIME_URL=wss://voice.example/realtime', {
    QWEN_AUDIO_REALTIME_API_KEY: 'do-not-restore', QWEN_AUDIO_REALTIME_URL: 'wss://fallback.example',
  })
  assert.equal(settings.realtimeApiKey, '')
  assert.equal(settings.realtimeUrl, 'wss://voice.example/realtime')
})

test('provider profile state isolates drafts and round-trips the flat settings contract', () => {
  const settings = realtimeSettingsValues({
    realtimeProvider: 'stepfun',
    realtimeApiKey: 'stepfun-secret',
    realtimeModel: 'stepaudio-3-realtime-preview',
    realtimeVoice: 'qingchunshaonv',
  })
  const state = realtimeSettingsProfileState(settings)

  assert.equal(state.activeProvider, 'stepfun')
  assert.deepEqual(Object.keys(state.profiles.stepfun).sort(), [
    'credential', 'endpoint', 'model', 'voice',
  ])
  assert.equal(state.profiles.stepfun.credential, 'stepfun-secret')
  assert.deepEqual(Object.keys(state.profiles), ['stepfun'])
  assert.equal('realtimeApiKey' in state.profiles.stepfun, false)
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.profiles), true)
  assert.equal(Object.isFrozen(state.profiles.stepfun), true)
  assert.deepEqual(realtimeSettingsFromProfileState(state), settings)
})

test('profile state conversion ignores inactive providers and unknown fields', () => {
  const values = realtimeSettingsFromProfileState({
    activeProvider: 'dashscope',
    profiles: {
      stepfun: { model: 'custom-stepfun-model', unrelated: 'ignored' },
      unknown: { secret: 'ignored' },
    },
  })

  assert.equal(values.realtimeProvider, realtimeSettingsValues().realtimeProvider)
  assert.equal(values.realtimeModel, realtimeSettingsValues().realtimeModel)
  assert.equal('unrelated' in values, false)
  assert.equal('secret' in values, false)
})

test('switching to an unvisited provider uses clean defaults', () => {
  const initial = realtimeSettingsProfileState({
    realtimeProvider: 'dashscope', realtimeModel: 'qwen3.5-omni-plus-realtime',
    realtimeApiKey: 'secret',
  })
  const selected = { ...initial, activeProvider: 'stepfun' }
  const values = realtimeSettingsFromProfileState(selected)
  assert.equal(values.realtimeProvider, 'stepfun')
  assert.equal(values.realtimeModel, 'stepaudio-3-realtime-preview')
  assert.equal(values.realtimeApiKey, '')
})
