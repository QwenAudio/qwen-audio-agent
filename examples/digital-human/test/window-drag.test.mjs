import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { bindWindowDrag } from '../desktop/window-drag.mjs'

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
