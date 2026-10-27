import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { bindWindowDrag } from '../desktop/window-drag.mjs'
import { installWindowDrag } from '../client/window-drag.mjs'

test('drag moves the owned window by screen displacement and stops on release/blur', () => {
  const ipc = new EventEmitter()
  const moves = []
  const window = { webContents: {}, isDestroyed: () => false, getPosition: () => [500, 200], setPosition: (x, y) => moves.push([x, y]) }
  const binding = bindWindowDrag({ ipc, getWindow: () => window })
  const event = { sender: window.webContents }
  ipc.emit('vidu-avatar:drag-start', event, { x: 550, y: 250 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 600, y: 280 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 620, y: 300 })
  assert.deepEqual(moves, [[550, 230], [570, 250]])
  ipc.emit('vidu-avatar:drag-end', event)
  ipc.emit('vidu-avatar:drag-move', event, { x: 640, y: 310 })
  assert.equal(moves.length, 2)
  ipc.emit('vidu-avatar:drag-start', event, { x: 550, y: 250 })
  binding.cancel()
  ipc.emit('vidu-avatar:drag-move', event, { x: 600, y: 280 })
  assert.equal(moves.length, 2)
  binding.dispose()
  assert.equal(ipc.eventNames().length, 0)
})

test('foreign senders and invalid coordinates cannot move the window', () => {
  const ipc = new EventEmitter()
  const moves = []
  const window = { webContents: {}, isDestroyed: () => false, getPosition: () => [0, 0], setPosition: (x, y) => moves.push([x, y]) }
  const binding = bindWindowDrag({ ipc, getWindow: () => window })
  const event = { sender: window.webContents }
  ipc.emit('vidu-avatar:drag-start', { sender: {} }, { x: 0, y: 0 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 10, y: 10 })
  ipc.emit('vidu-avatar:drag-start', event, { x: NaN, y: 0 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 10, y: 10 })
  ipc.emit('vidu-avatar:drag-start', event, { x: 0, y: 0 })
  ipc.emit('vidu-avatar:drag-move', { sender: {} }, { x: 10, y: 10 })
  ipc.emit('vidu-avatar:drag-move', event, { x: Infinity, y: 0 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 2147483648, y: 0 })
  ipc.emit('vidu-avatar:drag-move', event, { x: 10, y: 10 })
  assert.deepEqual(moves, [])
  binding.dispose()
})

function clientFixture(t) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const window = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
  })
  const element = new EventTarget(), captured = new Set(), classes = new Set(), calls = []
  Object.assign(element, {
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  })
  const bridge = {
    startDrag: point => calls.push(['start', point]),
    moveDrag: point => calls.push(['move', point]),
    endDrag: () => calls.push(['end']),
  }
  const dispatch = (type, fields = {}) => element.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    button: 0, pointerId: 1, screenX: 20, screenY: 40, ...fields,
  }))
  return { window, element, captured, classes, calls, bridge, dispatch }
}

test('client drag cleanup cancels an active drag and removes every listener', t => {
  const f = clientFixture(t)
  const cleanup = installWindowDrag(f.element, f.bridge)
  f.dispatch('pointerdown')
  f.dispatch('pointermove', { screenX: 30, screenY: 50 })
  assert.equal(f.captured.has(1), true)
  assert.equal(f.classes.has('dragging'), true)
  cleanup()
  cleanup()
  assert.deepEqual(f.calls, [['start', { x: 20, y: 40 }], ['move', { x: 30, y: 50 }], ['end']])
  assert.equal(f.captured.size, 0)
  assert.equal(f.classes.size, 0)
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.equal(getEventListeners(f.element, event).length, 0)
  }
  assert.equal(getEventListeners(f.window, 'blur').length, 0)
  f.dispatch('pointerdown')
  f.window.dispatchEvent(new Event('blur'))
  assert.equal(f.calls.length, 3)
})

test('client drag can be installed again without duplicate callbacks', t => {
  const f = clientFixture(t)
  installWindowDrag(f.element, f.bridge)()
  const cleanup = installWindowDrag(f.element, f.bridge)
  f.dispatch('pointerdown')
  f.dispatch('pointermove', { pointerId: 2 })
  f.dispatch('pointermove')
  f.window.dispatchEvent(new Event('blur'))
  f.dispatch('pointerup')
  assert.deepEqual(f.calls, [['start', { x: 20, y: 40 }], ['move', { x: 20, y: 40 }], ['end']])
  cleanup()
  assert.equal(f.calls.length, 3)
  assert.equal(getEventListeners(f.window, 'blur').length, 0)
})
