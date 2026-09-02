import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindOrbShell,
  configureOrbWindow,
  ORB_CHANNELS,
} from '../src/orb-shell.mjs'

function fakeIpc() {
  const listeners = new Map()
  const handlers = new Map()
  return {
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: channel => listeners.delete(channel),
    handle: (channel, handler) => {
      if (handlers.has(channel)) {
        throw new Error(`second handler for ${channel}`)
      }
      handlers.set(channel, handler)
    },
    removeHandler: channel => handlers.delete(channel),
    emit: (channel, event, payload) => listeners.get(channel)?.(event, payload),
    invoke: (channel, event, ...parameters) => (
      handlers.get(channel)(event, ...parameters)
    ),
    listeners,
    handlers,
  }
}

function fakeWindow(position = [100, 100]) {
  const webContents = {}
  return {
    webContents,
    position,
    getPosition() {
      return [...this.position]
    },
    setPosition(x, y) {
      this.position = [x, y]
    },
  }
}

function fakePresence() {
  return {
    state: 'active',
    calls: [],
    hide(reason) {
      this.calls.push(['hide', reason])
      this.state = 'hidden'
      return this.state
    },
    wake(reason) {
      this.calls.push(['wake', reason])
      this.state = 'waking'
    },
    ready() {
      this.calls.push(['ready'])
      this.state = 'active'
    },
  }
}

function shellHarness({
  window = fakeWindow(),
  onLoadSurface = () => 'orb',
} = {}) {
  const ipc = fakeIpc()
  const presence = fakePresence()
  const dragEnds = []
  const shell = bindOrbShell({
    ipc,
    getWindow: () => window,
    presence,
    onOpenSettings: () => dragEnds.push('settings'),
    onLoadSurface,
    onSetSurface: mode => {
      dragEnds.push(`surface:${mode}`)
      return mode
    },
    onSetConversationSession: sessionId => {
      dragEnds.push(`session:${sessionId}`)
      return sessionId
    },
    onQuit: () => dragEnds.push('quit'),
    onDragEnd: () => dragEnds.push('drag-end'),
  })
  const event = { sender: window.webContents }
  return { ipc, presence, shell, window, event, calls: dragEnds }
}

test('drags move the window and report the drop for persistence', () => {
  const { ipc, window, event, calls } = shellHarness()
  ipc.emit(ORB_CHANNELS.dragStart, event, { x: 10, y: 10 })
  ipc.emit(ORB_CHANNELS.dragMove, event, { x: 30, y: 25 })
  assert.deepEqual(window.position, [120, 115])
  ipc.emit(ORB_CHANNELS.dragEnd, event)
  assert.deepEqual(calls, ['drag-end'])
})

test('a wild pointer cannot throw in the main process', () => {
  const { ipc, window, event } = shellHarness()
  ipc.emit(ORB_CHANNELS.dragStart, event, { x: 0, y: 0 })
  ipc.emit(ORB_CHANNELS.dragMove, event, { x: Number.MAX_SAFE_INTEGER, y: 0 })
  // The drag is dropped instead of applied.
  assert.deepEqual(window.position, [100, 100])
  ipc.emit(ORB_CHANNELS.dragMove, event, { x: 5, y: 5 })
  assert.deepEqual(window.position, [100, 100])
})

test('a foreign sender can neither drag nor read lifecycle state', async () => {
  const { ipc, window, event } = shellHarness()
  const foreign = { sender: {} }
  ipc.emit(ORB_CHANNELS.dragStart, foreign, { x: 0, y: 0 })
  ipc.emit(ORB_CHANNELS.dragMove, foreign, { x: 9, y: 9 })
  assert.deepEqual(window.position, [100, 100])
  assert.throws(() => ipc.invoke(ORB_CHANNELS.lifecycleLoad, foreign), /无权/)
  assert.throws(() => ipc.invoke(ORB_CHANNELS.enterHide, foreign), /无权/)
  // The orb window itself is allowed.
  assert.deepEqual(ipc.invoke(ORB_CHANNELS.lifecycleLoad, event), {
    state: 'active',
  })
})

test('lifecycle channels drive the presence state machine', () => {
  const { ipc, presence, event } = shellHarness()
  assert.deepEqual(ipc.invoke(ORB_CHANNELS.enterHide, event), {
    state: 'hidden',
  })
  ipc.emit(ORB_CHANNELS.wake, event)
  assert.equal(presence.state, 'waking')
  ipc.emit(ORB_CHANNELS.lifecycleReady, event)
  assert.equal(presence.state, 'active')
  // ready is only meaningful while waking.
  ipc.emit(ORB_CHANNELS.lifecycleReady, event)
  assert.deepEqual(presence.calls.filter(([name]) => name === 'ready').length, 1)
})

test('quit and open-settings only request, never act on the window', () => {
  const { ipc, event, calls } = shellHarness()
  ipc.emit(ORB_CHANNELS.openSettings, event)
  ipc.emit(ORB_CHANNELS.quit, event)
  assert.deepEqual(calls, ['settings', 'quit'])
})

test('surface channels keep orb and panel in one authorized window', () => {
  const { ipc, event, calls } = shellHarness()
  assert.deepEqual(ipc.invoke(ORB_CHANNELS.surfaceLoad, event), { mode: 'orb' })
  assert.deepEqual(
    ipc.invoke(ORB_CHANNELS.surfaceSet, event, 'panel'),
    { mode: 'panel' },
  )
  assert.deepEqual(calls, ['surface:panel'])
  assert.throws(
    () => ipc.invoke(ORB_CHANNELS.surfaceSet, { sender: {} }, 'panel'),
    /无权/,
  )
})

test('conversation session changes cross the authorized orb host boundary', () => {
  const { ipc, event, calls } = shellHarness()
  assert.deepEqual(
    ipc.invoke(ORB_CHANNELS.conversationSessionSet, event, 'session-2'),
    { sessionId: 'session-2' },
  )
  assert.deepEqual(calls, ['session:session-2'])
  assert.throws(
    () => ipc.invoke(
      ORB_CHANNELS.conversationSessionSet,
      { sender: {} },
      'foreign-session',
    ),
    /无权/,
  )
})

test('visible conversation panel refuses an inactivity hide request', () => {
  const { ipc, event, presence } = shellHarness({
    onLoadSurface: () => 'panel',
  })

  assert.deepEqual(ipc.invoke(ORB_CHANNELS.enterHide, event), {
    state: presence.state,
  })
  assert.notEqual(presence.state, 'hidden')
})

test('explicit sleep closes a visible conversation panel and hides the desktop', () => {
  const { ipc, event, presence, calls } = shellHarness({
    onLoadSurface: () => 'panel',
  })

  assert.deepEqual(ipc.invoke(
    ORB_CHANNELS.enterHide,
    event,
    { explicit: true },
  ), { state: 'hidden' })
  assert.equal(presence.state, 'hidden')
  assert.deepEqual(calls, ['surface:orb'])
})

test('dispose unregisters every channel and cancelDrag drops the offset', () => {
  const { ipc, shell, window, event } = shellHarness()
  ipc.emit(ORB_CHANNELS.dragStart, event, { x: 0, y: 0 })
  shell.cancelDrag()
  ipc.emit(ORB_CHANNELS.dragMove, event, { x: 50, y: 50 })
  assert.deepEqual(window.position, [100, 100])
  shell.dispose()
  assert.equal(ipc.listeners.size, 0)
  assert.equal(ipc.handlers.size, 0)
})

test('configureOrbWindow applies the floating recipe', () => {
  const applied = []
  configureOrbWindow({
    setAlwaysOnTop: (...parameters) => applied.push(['top', ...parameters]),
    setVisibleOnAllWorkspaces: (...parameters) => applied.push(['spaces', ...parameters]),
  })
  assert.deepEqual(applied, [
    ['top', true, 'floating'],
    ['spaces', true, { visibleOnFullScreen: true }],
  ])
})
