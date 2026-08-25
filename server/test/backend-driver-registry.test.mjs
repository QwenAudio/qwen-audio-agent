import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backendDefinition,
  backendNames,
  resolveBackendOwnership,
} from '../../shared/backend-catalog.mjs'
import {
  backendDriver,
  createBackendProfile,
} from '../src/agent/backends/registry.mjs'
import {
  backendRuntimeDriver,
} from '../src/process/backend-drivers/registry.mjs'

test('every advertised backend has Agent and Runtime drivers', () => {
  for (const protocol of backendNames()) {
    assert.equal(backendDriver(protocol).id, protocol)
    const runtime = backendRuntimeDriver(protocol)
    const definition = backendDefinition(protocol)
    assert.equal(runtime.id, protocol)
    assert.equal(runtime.baseUrlEnvironment, definition.baseUrlEnvironment)
    assert.equal(runtime.defaultBaseUrl, definition.defaultBaseUrl)
    assert.equal(
      Boolean(runtime.supportsExternalService),
      Boolean(definition.supportsExternalService),
    )
  }
})

test('every Agent driver publishes one validated capability contract', () => {
  for (const protocol of backendNames()) {
    const driver = backendDriver(protocol)
    for (const capability of [
      'delegation',
      'permissions',
      'backendUi',
      'nativeSessionHistory',
      'externalMcp',
      'nativeDelegation',
      'sessionMcp',
      'coordinatorMcpInstructions',
    ]) {
      assert.equal(typeof driver.capabilities[capability], 'boolean', (
        `${protocol}.${capability}`
      ))
    }
  }
})

test('profile construction applies the immutable driver capability contract', () => {
  const profile = createBackendProfile('deepseek', {
    root: '/repo',
    directory: '/work',
    sessionRoot: '/state',
    permissionMode: 'native',
  })
  assert.deepEqual(profile.capabilities, {
    delegation: false,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: false,
    externalMcp: false,
    nativeDelegation: false,
    sessionMcp: false,
    coordinatorMcpInstructions: false,
  })
  assert.equal(Object.isFrozen(profile.capabilities), true)
})

test('enables MCP coordinator instructions only for verified Agent hosts', () => {
  for (const protocol of ['opencode', 'qoder', 'qwen', 'claude']) {
    assert.equal(
      backendDriver(protocol).capabilities.coordinatorMcpInstructions,
      true,
    )
  }
  for (const protocol of backendNames().filter(
    value => !['opencode', 'qoder', 'qwen', 'claude'].includes(value),
  )) {
    assert.equal(
      backendDriver(protocol).capabilities.coordinatorMcpInstructions,
      false,
    )
  }
})

test('external ownership is available only to declared backend services', () => {
  assert.equal(resolveBackendOwnership('openclaw', {
    baseUrlConfigured: true,
  }), 'external')
  assert.equal(resolveBackendOwnership('openclaw'), 'owned')
  assert.equal(resolveBackendOwnership('opencode', {
    baseUrlConfigured: true,
  }), 'owned')
  assert.throws(() => resolveBackendOwnership('opencode', {
    requestedOwnership: 'external',
  }), /不支持连接外部后台服务/)
})
