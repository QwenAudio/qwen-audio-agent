import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backendDefinition,
  effectiveBackendPermissionMode,
} from '../shared/backend-catalog.mjs'

test('Pi declares the always-full-permission capability', () => {
  // Pi 没有内置沙箱与权限审批，任何配置下都等效 full；该能力必须显式声明，
  // 配置解析、健康状态与桌面 UI 统一据此展示真实生效的权限。
  const pi = backendDefinition('pi')
  assert.equal(pi.alwaysFullPermission, true)
  assert.equal(pi.supportsFullPermission, true)
})

test('effective permission mode normalizes always-full backends', () => {
  assert.equal(effectiveBackendPermissionMode('pi', 'native'), 'full')
  assert.equal(effectiveBackendPermissionMode('pi', 'full'), 'full')
  assert.equal(effectiveBackendPermissionMode('pi', undefined), 'full')
  assert.equal(effectiveBackendPermissionMode('pi', ''), 'full')
})

test('effective permission mode leaves other backends untouched', () => {
  assert.equal(effectiveBackendPermissionMode('codex', 'native'), 'native')
  assert.equal(effectiveBackendPermissionMode('codex', 'full'), 'full')
  assert.equal(effectiveBackendPermissionMode('codex', undefined), 'native')
  assert.equal(effectiveBackendPermissionMode('', 'full'), 'full')
  assert.equal(effectiveBackendPermissionMode('openclaw', 'NATIVE'), 'native')
})
