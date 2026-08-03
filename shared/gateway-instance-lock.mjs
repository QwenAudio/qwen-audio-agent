import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

export const GATEWAY_LOCK_SCHEMA = 'qwaudio.gateway-lock/v1'

export function gatewayLockPath(configDirectory) {
  return resolve(configDirectory, 'gateway.lock')
}

function processIsAlive(pid, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    killImpl(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function readGatewayLease(configDirectory) {
  try {
    const lease = JSON.parse(readFileSync(gatewayLockPath(configDirectory), 'utf8'))
    return lease?.schema === GATEWAY_LOCK_SCHEMA
      && typeof lease.instanceId === 'string'
      ? lease
      : null
  } catch {
    return null
  }
}

function sameLease(left, right) {
  return Boolean(
    left?.instanceId
    && left.instanceId === right?.instanceId
    && left.pid === right?.pid,
  )
}

function writeLease(path, lease) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(lease)}\n`, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function replaceLease(path, lease) {
  const temporary = `${path}.${lease.instanceId}.tmp`
  try {
    writeLease(temporary, lease)
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function moveStaleLease(path, token) {
  const stale = `${path}.stale.${token}`
  try {
    renameSync(path, stale)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    unlinkSync(stale)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return true
}

export function acquireGatewayLease(configDirectory, {
  pid = process.pid,
  owner = 'gateway',
  instanceId = randomUUID(),
  now = () => new Date(),
  killImpl = process.kill,
} = {}) {
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  const path = gatewayLockPath(configDirectory)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const timestamp = now().toISOString()
    const lease = {
      schema: GATEWAY_LOCK_SCHEMA,
      instanceId,
      pid,
      owner,
      state: 'starting',
      origin: '',
      startedAt: timestamp,
      heartbeatAt: timestamp,
    }
    try {
      writeLease(path, lease)
      let released = false
      return Object.freeze({
        path,
        instanceId,
        pid,
        get released() {
          return released
        },
        update(fields = {}) {
          if (released) return false
          const current = readGatewayLease(configDirectory)
          if (!sameLease(current, lease)) return false
          Object.assign(lease, fields, {
            schema: GATEWAY_LOCK_SCHEMA,
            instanceId,
            pid,
            heartbeatAt: now().toISOString(),
          })
          replaceLease(path, lease)
          return true
        },
        release() {
          if (released) return false
          released = true
          const current = readGatewayLease(configDirectory)
          if (!sameLease(current, lease)) return false
          try {
            unlinkSync(path)
            return true
          } catch (error) {
            if (error?.code === 'ENOENT') return false
            throw error
          }
        },
      })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = readGatewayLease(configDirectory)
      if (existing && processIsAlive(Number(existing.pid), killImpl)) {
        const conflict = new Error(
          `已有 Gateway 正在运行${existing.origin ? `：${existing.origin}` : ''}`,
        )
        conflict.code = 'QWAUDIO_GATEWAY_ALREADY_RUNNING'
        conflict.lease = existing
        throw conflict
      }
      if (!moveStaleLease(path, instanceId)) continue
    }
  }
  throw new Error('无法获取 Gateway 实例租约')
}

export async function findRunningGateway(configDirectory, {
  readHealth,
  timeoutMs = 3000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const lease = readGatewayLease(configDirectory)
    if (!lease) return null
    if (lease.origin) {
      const health = await readHealth(lease.origin)
      if (
        health
        && health.gatewayInstanceId === lease.instanceId
      ) {
        return { lease, origin: lease.origin, health }
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  } while (true)
}
