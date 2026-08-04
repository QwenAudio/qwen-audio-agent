import assert from 'node:assert/strict'
import test from 'node:test'
import { createTrayMenuTemplate } from '../src/tray-menu.mjs'

function harness({ state = 'ready', orbVisible = true, mode = 'managed' } = {}) {
  const calls = []
  const actions = Object.fromEntries([
    'toggleOrb',
    'openSettings',
    'manageRuntime',
    'restartRuntime',
    'setOpenAtLogin',
    'checkForUpdates',
    'quit',
  ].map(name => [name, (...args) => calls.push([name, ...args])]))
  const menu = createTrayMenuTemplate({
    runtimeStatus: {
      state,
      distribution: 'Ubuntu',
      retry: state === 'recovering' ? 2 : undefined,
    },
    preferences: {
      mode,
      orbVisible,
      openAtLogin: true,
    },
    updaterStatus: { phase: 'idle' },
    actions,
  })
  return { actions, calls, menu }
}

function item(menu, id) {
  return menu.find(entry => entry.id === id)
}

test('maps every stable runtime state to a disabled concise status row', () => {
  const expected = {
    checking: 'Checking WSL...',
    'setup-required': 'WSL setup required',
    starting: 'Starting WSL runtime...',
    ready: 'WSL ready - Ubuntu',
    recovering: 'Reconnecting to WSL (2/3)...',
    external: 'External Gateway connected',
    error: 'WSL runtime error',
  }
  for (const [state, label] of Object.entries(expected)) {
    const status = item(harness({ state }).menu, 'runtime-status')
    assert.equal(status.label, label)
    assert.equal(status.enabled, false)
  }
})

test('provides every required command with stable enabled and checkbox state', () => {
  const target = harness()
  assert.deepEqual(
    target.menu.filter(entry => entry.id).map(entry => entry.id),
    [
      'runtime-status',
      'toggle-orb',
      'settings',
      'manage-runtime',
      'restart-runtime',
      'open-at-login',
      'check-updates',
      'quit',
    ],
  )
  assert.equal(item(target.menu, 'toggle-orb').label, 'Hide floating orb')
  assert.equal(item(target.menu, 'restart-runtime').enabled, true)
  assert.equal(item(target.menu, 'open-at-login').type, 'checkbox')
  assert.equal(item(target.menu, 'open-at-login').checked, true)
  item(target.menu, 'toggle-orb').click()
  item(target.menu, 'settings').click()
  item(target.menu, 'manage-runtime').click()
  item(target.menu, 'restart-runtime').click()
  item(target.menu, 'open-at-login').click({ checked: false })
  item(target.menu, 'check-updates').click()
  item(target.menu, 'quit').click()
  assert.deepEqual(target.calls, [
    ['toggleOrb'],
    ['openSettings'],
    ['manageRuntime'],
    ['restartRuntime'],
    ['setOpenAtLogin', false],
    ['checkForUpdates'],
    ['quit'],
  ])
})

test('adjusts orb and runtime commands for setup, external, and update states', () => {
  const setup = harness({ state: 'setup-required', orbVisible: false })
  assert.equal(item(setup.menu, 'toggle-orb').label, 'Show floating orb')
  assert.equal(item(setup.menu, 'toggle-orb').enabled, false)
  assert.equal(item(setup.menu, 'restart-runtime').enabled, false)

  const external = harness({ state: 'external', mode: 'external' })
  assert.equal(item(external.menu, 'restart-runtime').enabled, false)
  const unavailable = createTrayMenuTemplate({
    runtimeStatus: { state: 'external', reason: 'external-unavailable' },
    preferences: { mode: 'external', orbVisible: false, openAtLogin: false },
    actions: external.actions,
  })
  assert.equal(
    item(unavailable, 'runtime-status').label,
    'External Gateway unavailable',
  )

  const updating = harness()
  const check = item(createTrayMenuTemplate({
    runtimeStatus: { state: 'ready', distribution: 'Ubuntu' },
    preferences: { mode: 'managed', orbVisible: true, openAtLogin: false },
    updaterStatus: { phase: 'checking' },
    actions: updating.actions,
  }), 'check-updates')
  assert.equal(check.enabled, false)
})
