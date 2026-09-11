import { backendDefinition } from './catalog.mjs'

function clean(value) {
  return String(value || '').trim()
}

function usesAutomaticBailianConfiguration(id, env) {
  const model = clean(env.QWEN_AUDIO_AGENT_BACKEND_MODEL).toLowerCase()
  return (
    ['opencode', 'openclaw'].includes(id)
    && Boolean(clean(env.DASHSCOPE_API_KEY))
    && Boolean(model)
    && model !== 'auto'
  )
}

// Unified onboarding contract consumed by CLI and desktop. A backend owns the
// details of configuration; callers only render and invoke trusted actions.
// More action kinds (browser/form/instructions) can be added without changing
// the settings UI lifecycle.
export function backendOnboardingAdapter(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const definition = backendDefinition(id)
  const lifecycle = definition?.lifecycle || null
  const adapter = definition?.onboarding || null
  const command = clean(adapter?.command)
  const automatic = usesAutomaticBailianConfiguration(definition?.id, env)
  const supportedPlatform = ['darwin', 'linux', 'win32'].includes(platform)
  const action = command && !automatic
    ? {
        id: 'configure',
        kind: 'terminal',
        label: '配置',
        command,
        hint: clean(adapter?.hint),
      }
    : null

  return {
    id: definition?.id || clean(id),
    installation: lifecycle?.installation || null,
    configuration: {
      ...(lifecycle?.configuration || { mode: 'user-managed' }),
      automatic,
      action: action && supportedPlatform ? action : null,
      probe: adapter?.probe || null,
    },
  }
}

export function backendConfigurationAction(id, options) {
  return backendOnboardingAdapter(id, options).configuration.action
}

export function resolveBackendOnboarding(item, {
  installation,
  configuration,
} = {}) {
  const installed = item?.ready === true
  const configurationRequired = configuration?.required === true
  let state = 'not-installed'
  if (installed && configurationRequired) state = 'configuration-required'
  else if (installed) state = 'installed'

  return {
    state,
    installation: {
      ...installation,
      status: installed ? 'installed' : 'not-installed',
    },
    configuration,
    // Runtime readiness is measured by the live connection, never inferred
    // from installation or local credential files.
    readiness: { status: 'not-connected' },
  }
}
