import { posix } from 'node:path'
import {
  backendDefinition,
  effectiveBackendPermissionMode,
  normalizeBackendProtocol,
  resolveBackendOwnership,
} from '../../shared/backend-catalog.mjs'
import {
  resolveRealtimeFrontendConfiguration,
  resolveDashScopeRealtimeModelProfile,
} from '../../shared/realtime-provider-catalog.mjs'

// Gateway 子进程托管器随包发布（宿主与桌面版共用同一份实现，防漂移）；
// 本文件只保留桌面特有的环境构建与兼容性检查。
export {
  DEFAULT_GATEWAY_ENTRY,
  GATEWAY_READY_MESSAGE,
  GatewayProcess,
  GatewayProcess as EmbeddedGateway,
  createGatewayProcess,
  portInUse,
  validateGatewayOrigin,
} from '../../shared/gateway-process.mjs'

function uniquePath(entries, separator = ':') {
  return [...new Set(entries.filter(Boolean))].join(separator)
}

// Gateway 子进程的 PATH 直接继承主进程：主进程入口的 expandProcessPath
// 已把登录 shell 的 PATH（含磁盘缓存，零阻塞）合入 process.env，这里只
// 叠加常见安装目录兜底。不要再在这里同步调用登录 shell——主进程事件
// 循环会被阻塞数秒，直接拖慢桌面启动。
export function desktopExecutablePath({
  env = process.env,
  platform = process.platform,
} = {}) {
  const separator = platform === 'win32' ? ';' : ':'
  const configured = String(env.PATH || '').split(separator)
  if (platform !== 'darwin') return uniquePath(configured, separator)
  return uniquePath([
    env.HOME ? posix.join(env.HOME, '.local/bin') : '',
    env.HOME ? posix.join(env.HOME, '.npm-global/bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...configured,
  ], separator)
}

export function desktopGatewayEnvironment({
  env = process.env,
  configured = {},
  runtimeRoot = '',
  sourceRoot = '',
  platform = process.platform,
} = {}) {
  const merged = {
    ...env,
    ...configured,
  }
  if (Object.hasOwn(configured, 'DASHSCOPE_API_KEY')) {
    merged.QWEN_AUDIO_REALTIME_API_KEY = configured.DASHSCOPE_API_KEY
  }
  return {
    ...merged,
    PATH: desktopExecutablePath({
      env: merged,
      platform,
    }),
    QWEN_AUDIO_AGENT_DESKTOP: '1',
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    ...(runtimeRoot
      ? { QWEN_AUDIO_AGENT_RUNTIME_ROOT: runtimeRoot }
      : {}),
    ...(sourceRoot
      ? { QWEN_AUDIO_AGENT_SOURCE_ROOT: sourceRoot }
      : {}),
  }
}

export function desktopGatewayCompatibility(health, env = process.env) {
  const expectedRealtime = resolveRealtimeFrontendConfiguration(env)
  if (health?.realtimeModel || health?.realtimeModelProfile?.id) {
    const actualModel = String(
      health.realtimeModelProfile?.id || health.realtimeModel,
    ).trim()
    const expectedModel = resolveDashScopeRealtimeModelProfile(
      expectedRealtime.dashscopeModel,
    ).id
    if (expectedRealtime.provider === 'dashscope' && actualModel !== expectedModel) {
      return {
        compatible: false,
        code: 'realtime-model',
        reason: '已有 Gateway 的 Realtime 模型与桌面设置不一致',
      }
    }
  }
  if (
    health?.realtimeProvider !== expectedRealtime.provider
    || health?.realtimeConfigurationSignature !== expectedRealtime.signature
  ) {
    return {
      compatible: false,
      code: 'realtime',
      reason: '已有 Gateway 的语音前台配置与桌面设置不一致',
    }
  }
  const expectedProtocol = normalizeBackendProtocol(env.AGENT_PROTOCOL)
  const actualEnabled = health?.backend?.enabled !== false
  const actualProtocol = normalizeBackendProtocol(
    health?.backend?.kind || health?.backend?.protocol,
  )
  if (
    actualEnabled !== Boolean(expectedProtocol)
    || actualProtocol !== expectedProtocol
  ) {
    return {
      compatible: false,
      code: 'backend',
      reason: '已有 Gateway 的后台 Agent 与桌面设置不一致',
    }
  }
  if (expectedProtocol) {
    const definition = backendDefinition(expectedProtocol)
    const configuredBaseUrl = String(
      definition?.baseUrlEnvironment
        ? env[definition.baseUrlEnvironment] || ''
        : '',
    ).trim()
    const expectedOwnership = resolveBackendOwnership(expectedProtocol, {
      baseUrlConfigured: Boolean(configuredBaseUrl),
      requestedOwnership: env.QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP,
    })
    const actualOwnership = String(
      health?.backend?.ownership
      || (health?.backend?.mode === 'compatible' ? 'external' : 'owned'),
    ).toLowerCase()
    if (expectedOwnership !== actualOwnership) {
      return {
        compatible: false,
        code: 'ownership',
        reason: '已有 Gateway 的后台进程归属与桌面设置不一致',
      }
    }
    if (expectedOwnership === 'external' && definition?.baseUrlEnvironment) {
      const actualBaseUrl = String(health?.backend?.baseUrl || '').trim()
      let sameOrigin = false
      try {
        sameOrigin = Boolean(actualBaseUrl)
          && new URL(actualBaseUrl).origin === new URL(configuredBaseUrl).origin
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) {
        return {
          compatible: false,
          code: 'backend-url',
          reason: '已有 Gateway 的外部后台地址与桌面设置不一致',
        }
      }
    }
    const expectedPermission = effectiveBackendPermissionMode(
      expectedProtocol,
      env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE,
    )
    const actualPermission = String(
      health?.backend?.permissionMode || 'native',
    ).toLowerCase()
    if (expectedPermission !== actualPermission) {
      return {
        compatible: false,
        code: 'permission',
        reason: '已有 Gateway 的后台权限模式与桌面设置不一致',
      }
    }
    const expectedModel = String(
      env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '',
    ).trim().toLowerCase()
    const actualModel = String(health?.backend?.model || '').trim().toLowerCase()
    if (expectedModel && expectedModel !== actualModel) {
      return {
        compatible: false,
        code: 'model',
        reason: '已有 Gateway 的后台模型与桌面设置不一致',
      }
    }
  }
  return { compatible: true, code: '', reason: '' }
}

export function assertDesktopGatewayCompatibility(health, env = process.env) {
  const result = desktopGatewayCompatibility(health, env)
  if (!result.compatible) {
    throw new Error(`${result.reason}，请先关闭现有 Gateway`)
  }
}

export function resolveBorrowedGatewayAttachment(active, env = process.env) {
  const compatibility = desktopGatewayCompatibility(active?.health, env)
  if (!compatibility.compatible && compatibility.code === 'realtime-model') {
    throw new Error(`${compatibility.reason}，请先关闭现有 Gateway`)
  }
  return {
    origin: active.origin,
    compatibility,
  }
}
