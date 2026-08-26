import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthorizationStatus,
  normalizeAuthorization,
  publicAuthorization,
  resolveAuthorization,
} from '../src/core/work-authorization.mjs'

test('normalizes one bounded pending authorization request', () => {
  const authorization = normalizeAuthorization({
    id: 'auth_1',
    category: 'shell',
    summary: '  执行   npm test  ',
    patterns: ['npm test', '', 'npm test -- server'],
  }, { taskId: 'work_1', now: 10 })
  assert.deepEqual(authorization, {
    id: 'auth_1',
    taskId: 'work_1',
    status: AuthorizationStatus.PENDING,
    category: 'shell',
    summary: '执行 npm test',
    patterns: ['npm test', 'npm test -- server'],
    approvalScope: 'session',
    operation: null,
    createdAt: 10,
    resolvedAt: null,
  })
})

test('resolves authorization without mutating the pending request', () => {
  const pending = normalizeAuthorization({
    id: 'auth_1',
    summary: '写入文件',
  }, { taskId: 'work_1', now: 10 })
  const resolved = resolveAuthorization(
    pending,
    AuthorizationStatus.APPROVED,
    { now: 20 },
  )
  assert.equal(pending.status, AuthorizationStatus.PENDING)
  assert.equal(resolved.status, AuthorizationStatus.APPROVED)
  assert.equal(resolved.createdAt, 10)
  assert.equal(resolved.resolvedAt, 20)
  assert.deepEqual(publicAuthorization(resolved), resolved)
})

test('rejects malformed requests and invalid resolution states', () => {
  assert.equal(normalizeAuthorization({ id: 'auth_1' }), null)
  assert.equal(normalizeAuthorization({ summary: '执行命令' }), null)
  assert.equal(resolveAuthorization({
    id: 'auth_1',
    summary: '执行命令',
  }, AuthorizationStatus.PENDING), null)
})
