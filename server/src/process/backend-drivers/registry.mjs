import { codeBuddyRuntimeDriver } from './codebuddy.mjs'
import { claudeRuntimeDriver } from './claude.mjs'
import { codexRuntimeDriver } from './codex.mjs'
import { genericAcpRuntimeDriver } from './generic-acp.mjs'
import { hermesRuntimeDriver } from './hermes.mjs'
import { kimiRuntimeDriver } from './kimi.mjs'
import { openClawRuntimeDriver } from './openclaw.mjs'
import { openCodeRuntimeDriver } from './opencode.mjs'
import { qoderRuntimeDriver } from './qoder.mjs'

const drivers = new Map([
  openCodeRuntimeDriver,
  openClawRuntimeDriver,
  qoderRuntimeDriver,
  kimiRuntimeDriver,
  hermesRuntimeDriver,
  codeBuddyRuntimeDriver,
  codexRuntimeDriver,
  claudeRuntimeDriver,
  genericAcpRuntimeDriver,
].map(driver => [driver.id, driver]))

export function normalizeBackendRuntimeProtocol(protocol) {
  const id = String(protocol || '').trim().toLowerCase()
  return id === 'none' ? '' : id
}

export function backendRuntimeDriver(protocol) {
  const id = normalizeBackendRuntimeProtocol(protocol)
  const driver = drivers.get(id)
  if (!driver) throw new Error(`不支持的后台 Agent：${id}`)
  return driver
}
