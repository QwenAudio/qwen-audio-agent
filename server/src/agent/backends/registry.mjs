import { codeBuddyBackendDriver } from './codebuddy.mjs'
import { claudeBackendDriver } from './claude.mjs'
import { codexBackendDriver } from './codex.mjs'
import { genericAcpBackendDriver } from './generic-acp.mjs'
import { hermesBackendDriver } from './hermes.mjs'
import { kimiBackendDriver } from './kimi.mjs'
import { openClawBackendDriver } from './openclaw.mjs'
import { openCodeBackendDriver } from './opencode.mjs'
import { qoderBackendDriver } from './qoder.mjs'

const drivers = new Map([
  openCodeBackendDriver,
  openClawBackendDriver,
  qoderBackendDriver,
  kimiBackendDriver,
  hermesBackendDriver,
  codeBuddyBackendDriver,
  codexBackendDriver,
  claudeBackendDriver,
  genericAcpBackendDriver,
].map(driver => [driver.id, driver]))

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
