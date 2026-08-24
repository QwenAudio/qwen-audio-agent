import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceDesktopRuntimePresentation,
  desktopBackendRuntime,
  desktopRealtimeRuntime,
  resolveDesktopRuntime,
} from '../src/desktop-runtime.js'

test('treats front-end-only mode as a satisfied backend dependency', () => {
  assert.equal(desktopBackendRuntime({
    enabled: false,
    status: 'not_configured',
  }), 'skipped')
  assert.equal(desktopBackendRuntime({
    enabled: true,
    status: 'starting',
  }), 'connecting')
  assert.equal(desktopBackendRuntime({
    enabled: true,
    status: 'stopped',
    code: 'NOT_STARTED',
  }), 'connecting')
  assert.equal(desktopBackendRuntime({
    enabled: true,
    status: 'ready',
  }), 'ready')
  assert.equal(desktopBackendRuntime({
    enabled: true,
    status: 'failed',
  }), 'failed')
  assert.equal(desktopBackendRuntime({
    enabled: true,
    code: 'AUTH_REQUIRED',
  }), 'failed')
})

test('announces first readiness once without duplicating runtime failure state', () => {
  assert.deepEqual(advanceDesktopRuntimePresentation({
    current: 'ready',
    readyAnnounced: false,
  }), { cue: 'ready', readyAnnounced: true })
  assert.deepEqual(advanceDesktopRuntimePresentation({
    current: 'ready',
    readyAnnounced: true,
  }), { cue: null, readyAnnounced: true })
  assert.deepEqual(advanceDesktopRuntimePresentation({
    current: 'failed',
    readyAnnounced: true,
  }), { cue: null, readyAnnounced: true })
  assert.deepEqual(advanceDesktopRuntimePresentation({
    current: 'failed',
    readyAnnounced: true,
  }), { cue: null, readyAnnounced: true })
})

test('normalizes realtime connection phases', () => {
  assert.equal(desktopRealtimeRuntime('connecting'), 'connecting')
  assert.equal(desktopRealtimeRuntime('connected'), 'ready')
  assert.equal(desktopRealtimeRuntime('unavailable'), 'failed')
})

test('reports ready only after every configured runtime component is ready', () => {
  assert.deepEqual(resolveDesktopRuntime({
    gateway: 'ready',
    realtime: 'ready',
    backend: 'skipped',
  }), {
    overall: 'ready',
    gateway: 'ready',
    realtime: 'ready',
    backend: 'skipped',
  })
  assert.equal(resolveDesktopRuntime({
    gateway: 'ready',
    realtime: 'ready',
    backend: 'connecting',
  }).overall, 'starting')
  assert.equal(resolveDesktopRuntime({
    gateway: 'ready',
    realtime: 'ready',
    backend: 'failed',
  }).overall, 'failed')
})
