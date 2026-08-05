import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireGatewayLease,
  findRunningGateway,
  gatewayLockPath,
  GATEWAY_LOCK_SCHEMA,
  readGatewayLease,
} from '../shared/gateway-instance-lock.mjs'

function missingProcess() {
  throw Object.assign(new Error('missing'), { code: 'ESRCH' })
}

test('allows only one live Gateway per configuration directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-gateway-lock-'))
  const first = acquireGatewayLease(directory, {
    pid: 101,
    instanceId: 'first',
    killImpl: pid => {
      if (pid === 101) return
      missingProcess()
    },
  })
  assert.throws(
    () => acquireGatewayLease(directory, {
      pid: 202,
      instanceId: 'second',
      killImpl: pid => {
        if (pid === 101) return
        missingProcess()
      },
    }),
    error => (
      error.code === 'QWAUDIO_GATEWAY_ALREADY_RUNNING'
      && error.lease.instanceId === 'first'
    ),
  )
  first.release()
})

test('publishes readiness and releases only its own Gateway lease', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-gateway-ready-'))
  const lease = acquireGatewayLease(directory, {
    pid: 303,
    instanceId: 'current',
    owner: 'desktop',
    killImpl: () => {},
  })
  assert.equal(lease.update({
    state: 'ready',
    origin: 'http://127.0.0.1:3101',
  }), true)
  assert.deepEqual(readGatewayLease(directory), {
    schema: GATEWAY_LOCK_SCHEMA,
    instanceId: 'current',
    pid: 303,
    owner: 'desktop',
    state: 'ready',
    origin: 'http://127.0.0.1:3101',
    startedAt: readGatewayLease(directory).startedAt,
    heartbeatAt: readGatewayLease(directory).heartbeatAt,
  })

  writeFileSync(gatewayLockPath(directory), JSON.stringify({
    schema: GATEWAY_LOCK_SCHEMA,
    instanceId: 'replacement',
    pid: 404,
  }))
  assert.equal(lease.release(), false)
  assert.equal(readGatewayLease(directory).instanceId, 'replacement')
})

test('recovers a stale Gateway lease atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-gateway-stale-'))
  writeFileSync(gatewayLockPath(directory), JSON.stringify({
    schema: GATEWAY_LOCK_SCHEMA,
    instanceId: 'stale',
    pid: 99,
  }))
  const lease = acquireGatewayLease(directory, {
    pid: 505,
    instanceId: 'fresh',
    killImpl: missingProcess,
  })
  assert.equal(readGatewayLease(directory).instanceId, 'fresh')
  lease.release()
})

test('discovers only the Gateway whose health identity matches its lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-gateway-find-'))
  const lease = acquireGatewayLease(directory, {
    pid: 606,
    instanceId: 'discoverable',
    killImpl: () => {},
  })
  lease.update({ state: 'ready', origin: 'http://127.0.0.1:3210' })

  assert.equal(await findRunningGateway(directory, {
    readHealth: async () => ({ gatewayInstanceId: 'different' }),
    timeoutMs: 0,
  }), null)
  const active = await findRunningGateway(directory, {
    readHealth: async origin => ({
      gatewayInstanceId: 'discoverable',
      origin,
    }),
    timeoutMs: 0,
  })
  assert.equal(active.origin, 'http://127.0.0.1:3210')
  assert.equal(active.health.gatewayInstanceId, 'discoverable')
  assert.match(readFileSync(gatewayLockPath(directory), 'utf8'), /discoverable/)
  lease.release()
})
