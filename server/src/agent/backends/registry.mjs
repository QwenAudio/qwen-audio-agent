import { codeBuddyBackendDriver } from './codebuddy.mjs'
import { claudeBackendDriver } from './claude.mjs'
import { codexBackendDriver } from './codex.mjs'
import { deepSeekHarnessBackendDriver } from './deepseek-harness.mjs'
import { genericAcpBackendDriver } from './generic-acp.mjs'
import { localAcpBackendDrivers } from './local-acp.mjs'
import { openClawBackendDriver } from './openclaw.mjs'
import { openCodeBackendDriver } from './opencode.mjs'
import { piBackendDriver } from './pi.mjs'
import { backendDefinition, validateBackendSkillsSpec } from '../../../../shared/backend-catalog.mjs'

const CAPABILITY_FLAGS = [
  'delegation',
  'permissions',
  'backendUi',
  'nativeSessionHistory',
  'externalMcp',
  'nativeDelegation',
  'sessionMcp',
]

function validateBackendDriver(driver) {
  const definition = backendDefinition(driver?.id)
  if (!definition) throw new Error(`后台 Driver 未在目录注册：${driver?.id}`)
  // skills 声明是接入协议的一部分，注册时强制校验。
  validateBackendSkillsSpec(definition)
  if (driver.label !== definition.label) {
    throw new Error(`后台 Driver 标签不一致：${driver.id}`)
  }
  if (typeof driver.createProfile !== 'function') {
    throw new Error(`后台 Driver 缺少 createProfile：${driver.id}`)
  }
  if (
    !driver.capabilities
    || CAPABILITY_FLAGS.some(flag => (
      typeof driver.capabilities[flag] !== 'boolean'
    ))
    || Object.values(driver.capabilities).some(value => (
      typeof value !== 'boolean'
    ))
  ) {
    throw new Error(`后台 Driver 能力声明不完整：${driver.id}`)
  }
  return driver
}

const drivers = new Map([
  openCodeBackendDriver,
  openClawBackendDriver,
  ...localAcpBackendDrivers,
  codeBuddyBackendDriver,
  codexBackendDriver,
  claudeBackendDriver,
  deepSeekHarnessBackendDriver,
  piBackendDriver,
  genericAcpBackendDriver,
].map(validateBackendDriver).map(driver => [driver.id, driver]))

export function backendDriver(protocol) {
  const id = String(protocol || '').trim().toLowerCase()
  const driver = drivers.get(id)
  if (!driver) throw new Error(`不支持的后台 Agent：${id}`)
  return driver
}

export function hasBackendDriver(protocol) {
  return drivers.has(String(protocol || '').trim().toLowerCase())
}

export function backendIds() {
  return [...drivers.keys()]
}

export function createBackendProfile(protocol, options) {
  const driver = backendDriver(protocol)
  const profile = driver.createProfile(options)
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`后台 Driver 返回了无效 Profile：${driver.id}`)
  }
  return {
    ...profile,
    ...driver.capabilities,
    capabilities: Object.freeze({ ...driver.capabilities }),
  }
}
