import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backendDefinition,
  backendNames,
  resolveBackendOwnership,
} from '../../shared/backend/catalog.mjs'
import {
  backendDriver,
  createBackendProfile,
} from '../src/backend/adapters/acp/drivers/registry.mjs'
import {
  backendRuntimeDriver,
} from '../src/process/backend-drivers/registry.mjs'
import {
  COORDINATOR_PROMPT_REFRESH_INTERVAL,
} from '../src/backend/adapters/acp/coordinator-instructions.mjs'

const acpBackendNames = () => backendNames().filter(protocol => (
  backendDefinition(protocol)?.setup?.integration !== 'msp'
))

test('every advertised ACP backend has Agent and Runtime drivers', () => {
  for (const protocol of acpBackendNames()) {
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
  for (const protocol of acpBackendNames()) {
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
    permissionMode: 'native',
  })
  assert.deepEqual(profile.capabilities, {
    delegation: false,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: false,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: false,
  })
  assert.equal(Object.isFrozen(profile.capabilities), true)
})

test('enables MCP coordinator instructions only for declared Agent hosts', () => {
  for (const protocol of ['opencode', 'qoder', 'qwen', 'claude', 'codex']) {
    assert.equal(
      backendDriver(protocol).capabilities.coordinatorMcpInstructions,
      true,
    )
  }
  for (const protocol of acpBackendNames().filter(
    value => !['opencode', 'qoder', 'qwen', 'claude', 'codex'].includes(value),
  )) {
    assert.equal(
      backendDriver(protocol).capabilities.coordinatorMcpInstructions,
      false,
    )
  }
})

test('all ACP coordinators use a shared cadence without driver-specific refresh settings', () => {
  assert.equal(COORDINATOR_PROMPT_REFRESH_INTERVAL, 20)
  for (const protocol of acpBackendNames()) {
    const profile = createBackendProfile(protocol, {
      root: '/repo', directory: '/work', permissionMode: 'native',
      baseUrl: 'http://127.0.0.1:3999',
      cliPath: '/test-acp',
    })
    assert.equal(Object.hasOwn(profile, 'coordinatorPromptRefreshInterval'), false, protocol)
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

test('keeps Muse on its MSP adapter instead of the ACP driver registry', () => {
  assert.equal(backendRuntimeDriver('muse').id, 'muse')
  assert.throws(() => backendDriver('muse'), /不支持的后台 Agent/)
})
