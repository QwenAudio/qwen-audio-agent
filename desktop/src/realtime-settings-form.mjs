import { REALTIME_PROVIDERS, REALTIME_SETTING_SLOTS, realtimeSettingsProfileState, realtimeSettingsFromProfileState, realtimeProfileFieldKey } from '../../shared/realtime-provider-definitions.mjs'
import { realtimeModelCatalog, resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { createSettingsPicker } from './settings-picker.mjs'

export function realtimeSettingsFields(provider, values) {
  const model = provider.settings.find(field => field.type === 'model')
  const profile = model ? resolveRealtimeModelProfile(values[model.key], provider.key) : null
  return REALTIME_SETTING_SLOTS.map(slot => {
    const field = provider.settings.find(field => field.slot === slot.slot
      && (!field.modelFamily || field.modelFamily === profile?.family))
    if (!field) {
      return {
        ...slot, disabled: true,
        displayValue: slot.slot === 'model' ? provider.modelLabel || '由服务端配置'
          : slot.slot === 'voice' && model ? '当前模型未提供音色配置' : '当前前台不支持配置',
      }
    }
    return {
      ...field, disabled: false,
      placeholder: field.modelFamily ? profile.sessionDefaults.voice || '模型默认音色'
        : field.placeholder || field.activeDefault || field.default,
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
  const values = () => realtimeSettingsFromProfileState(state)
  const currentProvider = () => REALTIME_PROVIDERS.find(provider => provider.key === state.activeProvider) || REALTIME_PROVIDERS[0]
  const picker = createSettingsPicker(pickerRoot, {
    translate,
    onSelect(value) {
      state.activeProvider = value
      for (const field of currentProvider().settings) {
        const profile = state.profiles[value]
        const key = realtimeProfileFieldKey(field)
        if (!profile[key] && field.activeDefault) profile[key] = field.activeDefault
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
        status: translate(values()[provider.requiredConfiguration.field]?.trim() ? '已配置' : '待配置'),
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
      const catalog = realtimeModelCatalog(provider.key)
      for (const profile of catalog?.profiles || []) {
        const option = make('option', '', profile.label)
        option.value = profile.id
        input.append(option)
      }
      if (values()[field.key] && ![...input.options].some(option => option.value === values()[field.key])) {
        const option = make('option', '', values()[field.key])
        option.value = values()[field.key]
        input.append(option)
      }
    } else {
      input.type = field.type
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = translate(field.placeholder || '')
    }
    input.value = values()[field.key]
    input.addEventListener('input', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      renderPicker()
      onChange()
    })
    input.addEventListener('change', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      if (field.type === 'model') {
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
    return row
  }

  function render() {
    const provider = currentProvider()
    state.activeProvider = provider.key
    renderPicker()
    const fields = realtimeSettingsFields(provider, values())
    const children = fields.map(field => renderField(field, provider))
    children.push(make('p', 'provider-attribution', provider.description))
    panel.replaceChildren(...children)
  }

  return {
    load(settings) { state = draft(settings); render() },
    values,
    render,
  }
}
