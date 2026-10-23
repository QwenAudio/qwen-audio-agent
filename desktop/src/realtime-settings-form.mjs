import { REALTIME_PROVIDERS, REALTIME_SETTING_SLOTS, realtimeSettingsProfileState, realtimeSettingsFromProfileState, realtimeProfileFieldKey } from '../../shared/realtime-provider-definitions.mjs'
import { realtimeModelCatalog, resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { createSettingsPicker } from './settings-picker.mjs'

export function realtimeSettingsFields(provider, values, catalogs) {
  const model = provider.settings.find(field => field.type === 'model')
  const profile = model ? resolveRealtimeModelProfile(values[model.key], provider.key, catalogs) : null
  return REALTIME_SETTING_SLOTS.map(slot => {
    const field = provider.settings.find(field => field.slot === slot.slot
      && (slot.slot !== 'voice' || profile?.api))
    if (!field) {
      return {
        ...slot, key: undefined, disabled: true,
        displayValue: slot.slot === 'model' ? provider.modelLabel || '由服务端配置'
          : slot.slot === 'voice' && model ? '当前模型未提供音色配置' : '当前前台不支持配置',
      }
    }
    return {
      ...field, disabled: false,
      placeholder: field.slot === 'voice'
        ? profile?.sessionDefaults.voice || field.placeholder || field.default || '模型默认音色'
        : field.placeholder || field.default,
    }
  })
}

export function createRealtimeSettingsForm({ pickerRoot, panel, onChange, openExternal, translate = text => text }) {
  const document = panel.ownerDocument
  const draft = settings => {
    const initial = realtimeSettingsProfileState(settings)
    return { activeProvider: initial.activeProvider, profiles: Object.fromEntries(
      Object.entries(initial.profiles).map(([key, profile]) => [key, { ...profile }]),
    ) }
  }
  let state = draft()
  let modelCatalogs
  let modelCatalogError = ''
  const values = () => realtimeSettingsFromProfileState(state)
  const currentProvider = () => REALTIME_PROVIDERS.find(provider => provider.key === state.activeProvider) || REALTIME_PROVIDERS[0]
  const picker = createSettingsPicker(pickerRoot, {
    translate,
    onSelect(value) {
      state.activeProvider = value
      // Drafts only live while this form is open. A newly selected provider
      // starts clean; saving returns just its connection settings.
      if (!state.profiles[value]) state.profiles[value] = {
        ...realtimeSettingsProfileState({ realtimeProvider: value }).profiles[value],
      }
      render()
      onChange()
    },
  })
  const make = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = translate(text)
    return node
  }

  function renderPicker() {
    picker.render({
      title: translate('选择实时语音引擎'), value: state.activeProvider,
      options: REALTIME_PROVIDERS.map(provider => ({
        value: provider.key, label: translate(provider.displayLabel || provider.label),
        keywords: `${provider.label} ${translate(provider.description)} ${provider.aliases.join(' ')}`,
        status: translate(state.profiles[provider.key]?.[realtimeProfileFieldKey(
          provider.settings.find(field => field.key === provider.requiredConfiguration.field),
        )]?.trim() ? '已配置' : '待配置'),
      })),
    })
  }

  function renderField(field, provider) {
    const row = make('div', 'setting-row')
    const label = make('label', '', field.label)
    label.htmlFor = `realtime-${field.key || `${provider.key}-${field.slot}`}`
    const input = make(field.type === 'model' && !field.disabled ? 'select' : 'input')
    input.id = label.htmlFor
    input.dataset.realtimeSlot = field.slot
    if (field.disabled) {
      input.type = 'text'
      input.disabled = true
      input.dataset.settingUnavailable = ''
      input.value = translate(field.displayValue)
      input.title = translate('当前前台不支持配置')
      row.append(label, input)
      return row
    }
    input.dataset.setting = field.key
    if (field.type === 'model') {
      const catalog = realtimeModelCatalog(provider.key, modelCatalogs)
      for (const profile of catalog?.profiles || []) {
        const option = make('option', '', profile.label)
        option.value = profile.id
        input.append(option)
      }
      if (![...input.options].some(option => option.value === values()[field.key])) {
        // Retain stale persisted IDs visibly, never silently select a default.
        const option = make('option')
        option.textContent = `${values()[field.key]}${translate(modelCatalogError ? '（目录不可用）' : '（未登记）')}`
        option.value = values()[field.key]
        option.dataset.unregistered = ''
        input.append(option)
      }
    } else {
      input.type = field.type
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = translate(field.placeholder || '')
    }
    input.value = values()[field.key]
    const validateModel = () => {
      if (field.type !== 'model') return
      if (modelCatalogError) {
        input.setCustomValidity(translate('模型目录不可用，请修复目录配置后重新打开设置'))
        return
      }
      const registered = realtimeModelCatalog(provider.key, modelCatalogs)?.profiles
        .some(profile => profile.id === input.value)
      input.setCustomValidity(registered ? '' : translate('模型未登记，请选择列表中的模型，或先在 frontend-models.json 中登记'))
    }
    validateModel()
    input.addEventListener('input', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      validateModel()
      renderPicker()
      onChange()
    })
    input.addEventListener('change', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      validateModel()
      if (field.type === 'model') {
        state.profiles[provider.key].voice = ''
        render()
        panel.querySelector(`[data-setting="${field.key}"]`)?.focus()
      }
      onChange()
    })
    row.append(label)
    if (field.helpUrl) {
      const wrapper = make('div', 'field-with-action')
      const action = make('button', 'link-button', '获取 API Key')
      action.type = 'button'
      action.addEventListener('click', () => openExternal(field.helpUrl))
      wrapper.append(input, action)
      row.append(wrapper)
    } else row.append(input)
    if (field.type === 'model') {
      const hint = make('p', 'setting-hint', '选择内置或已登记的模型；新增模型请在 frontend-models.json 中登记')
      hint.id = `${input.id}-hint`
      input.setAttribute('aria-describedby', hint.id)
      row.append(hint)
    }
    return row
  }

  function render() {
    const provider = currentProvider()
    state.activeProvider = provider.key
    renderPicker()
    const fields = realtimeSettingsFields(provider, values(), modelCatalogs)
    const children = fields.map(field => renderField(field, provider))
    children.push(make('p', 'provider-attribution', provider.description))
    panel.replaceChildren(...children)
  }

  return {
    load(settings, catalogs, catalogError = '') {
      state = draft(settings)
      modelCatalogs = catalogs
      modelCatalogError = catalogError
      render()
    },
    values,
    render,
  }
}
