import { backendDefinition } from './catalog.mjs'
import {
  backendOnboardingAdapter,
  resolveBackendOnboarding,
} from './onboarding.mjs'

export function backendLifecycleSpec(id) {
  const definition = backendDefinition(id)
  const lifecycle = definition?.lifecycle
  if (!lifecycle) return null
  const action = backendOnboardingAdapter(id, { env: {} }).configuration.action
  return {
    ...lifecycle,
    // Compatibility for external consumers of the pre-onboarding shape.
    authentication: action
      ? { command: action.command, hint: action.hint }
      : null,
  }
}

export function backendConfigurationSupport(id, options) {
  return backendOnboardingAdapter(id, options).configuration
}

// 认证由后台 Agent 自己完成。这里仅描述是否存在可信的官方入口；
// OpenCode/OpenClaw 使用项目自动百炼配置时不再要求额外登录。
export function backendAuthenticationSupport(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const action = backendOnboardingAdapter(id, { env, platform })
    .configuration.action
  if (!action) {
    return { required: false, supported: false }
  }
  return {
    required: true,
    supported: true,
    command: action.command,
  }
}

export function resolveBackendLifecycle(item, {
  installation,
  configuration,
  authentication,
} = {}) {
  // Compatibility wrapper for callers still reading lifecycle/authentication.
  const onboarding = resolveBackendOnboarding(item, {
    installation,
    configuration: {
      ...configuration,
      required: authentication?.required === true,
      status: authentication?.status || 'unknown',
      actionAvailable: authentication?.actionAvailable === true,
      action: configuration?.action || null,
    },
  })
  return { ...onboarding, authentication }
}
