import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopPresence } from '../src/desktop-presence.mjs'

function harness() {
  const events = []
  const callbacks = new Map()
  const window = {
    hidden: false,
    shown: 0,
    focused: 0,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() { this.shown += 1 },
    focus() { this.focused += 1 },
    hide() { this.hidden = true },
    webContents: {
      send: (_channel, event) => events.push(event),
    },
  }
  const globalShortcut = {
    register: (value, callback) => {
      callbacks.set(value, callback)
      return value !== 'unavailable'
    },
    unregister: value => callbacks.delete(value),
    unregisterAll: () => callbacks.clear(),
  }
  const presence = new DesktopPresence({
    getWindow: () => window,
    globalShortcut,
  })
  return { callbacks, events, presence, window }
}

test('hides the orb and reconnects it through the waking lifecycle', () => {
  const { events, presence, window } = harness()
  assert.equal(presence.hide(), 'hidden')
  assert.equal(window.hidden, true)
  assert.deepEqual(events.at(-1), { state: 'hidden', reason: 'inactivity' })

  assert.equal(presence.wake('shortcut'), true)
  assert.equal(window.shown, 1)
  assert.deepEqual(events.at(-1), { state: 'waking', reason: 'shortcut' })
  assert.equal(presence.ready(), true)
  assert.deepEqual(events.at(-1), { state: 'active', reason: 'ready' })
})

test('keeps the previous shortcut when a replacement is unavailable', () => {
  const { callbacks, presence } = harness()
  assert.equal(presence.registerShortcut('old'), true)
  assert.equal(presence.registerShortcut('unavailable'), false)
  assert.equal(presence.shortcut, 'old')
  assert.equal(callbacks.has('old'), true)
})

test('explicit sleep interrupts waking and ignores a late ready acknowledgement', () => {
  const { presence, window, events } = harness()
  presence.hide()
  presence.wake()
  window.hidden = false
  assert.equal(presence.state, 'waking')
  assert.equal(presence.hide('requested'), 'hidden')
  assert.equal(window.hidden, true)
  assert.equal(presence.ready(), false)
  assert.deepEqual(events.at(-1), { state: 'hidden', reason: 'requested' })
})

test('automatic hiding still waits for wake readiness', () => {
  const { presence, window } = harness()
  presence.hide()
  presence.wake()
  window.hidden = false
  assert.equal(presence.hide(), 'waking')
  assert.equal(window.hidden, false)
})

test('keeps the actual sleep cause for lifecycle snapshots and repeated requests', () => {
  const { presence } = harness()
  presence.hide('inactivity')
  assert.equal(presence.reason, 'inactivity')
  presence.hide('requested')
  assert.equal(presence.reason, 'inactivity')
  presence.wake('shortcut')
  assert.equal(presence.reason, 'shortcut')
  presence.hide('requested')
  assert.equal(presence.reason, 'requested')
})

test('failed native hide does not publish a hidden lifecycle', () => {
  const { presence, window, events } = harness()
  window.hide = () => { throw new Error('hide failed') }
  assert.throws(() => presence.hide('requested'), /hide failed/)
  assert.equal(presence.state, 'active')
  assert.deepEqual(events, [])
})

test('temporarily releases and restores the configured shortcut', () => {
  const { callbacks, presence } = harness()
  presence.registerShortcut('wake')
  presence.pauseShortcut()
  assert.equal(callbacks.has('wake'), false)
  assert.equal(presence.shortcutPaused, true)
  assert.equal(presence.resumeShortcut(), true)
  assert.equal(callbacks.has('wake'), true)
})
