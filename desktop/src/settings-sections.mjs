const SETTINGS_SECTION_KEYS = Object.freeze({
  voice: Object.freeze([
    'dashscopeApiKey',
    'realtimeBaseUrl',
    'realtimeProvider',
    'realtimeModel',
    'audioRealtimeVoice',
    'omniRealtimeVoice',
    'speechToSpeechRealtimeUrl',
    'speechToSpeechAuthToken',
    'miniCpmORealtimeUrl',
    'miniCpmOAuthToken',
  ]),
  backend: Object.freeze([
    'agentProtocol',
    'backendModel',
    'backendOwnership',
    'backendUrl',
    'backendCredential',
    'nodePath',
  ]),
  app: Object.freeze([
    'gatewayUrl',
    'orbSkin',
    'autoHideSeconds',
    'wakeShortcut',
    'wakeWordEnabled',
    'language',
  ]),
})

function sectionKeys(section) {
  const keys = SETTINGS_SECTION_KEYS[section]
  if (!keys) throw new TypeError('invalid settings section')
  return keys
}

function requireSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid settings draft')
  }
  return value
}

export function settingsSectionPatch(settings, section) {
  const source = requireSettings(settings)
  return Object.fromEntries(sectionKeys(section)
    .filter(key => Object.hasOwn(source, key))
    .map(key => [key, source[key]]))
}

export function mergeSettingsSection(current, draft, section) {
  return {
    ...requireSettings(current),
    ...settingsSectionPatch(draft, section),
  }
}

export function settingsSectionChanged(current, draft, section) {
  const applied = requireSettings(current)
  const pending = requireSettings(draft)
  return sectionKeys(section).some(key => !Object.is(applied[key], pending[key]))
}

export function preserveSettingsDrafts(applied, draft, appliedSection) {
  sectionKeys(appliedSection)
  return Object.keys(SETTINGS_SECTION_KEYS)
    .filter(section => section !== appliedSection)
    .reduce(
      (next, section) => mergeSettingsSection(next, draft, section),
      { ...requireSettings(applied) },
    )
}
