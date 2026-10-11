// Only the owned renderer may move this host's window. Coordinates are CSS
// screen pixels, matching Electron's window position units.
export function bindWindowDrag({ ipc, getWindow }) {
  let drag = null
  const registrations = []
  const validPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
  const ownedWindow = event => {
    const window = getWindow()
    return window && !window.isDestroyed() && event.sender === window.webContents ? window : null
  }
  const on = (channel, handler) => {
    ipc.on(channel, handler)
    registrations.push(() => ipc.removeListener(channel, handler))
  }
  on('vidu-avatar:drag-start', (event, point) => {
    const window = ownedWindow(event)
    if (!window || !validPoint(point)) return
    const [x, y] = window.getPosition()
    drag = { pointer: point, x, y }
  })
  on('vidu-avatar:drag-move', (event, point) => {
    const window = ownedWindow(event)
    if (!window || !drag || !validPoint(point)) return
    const x = Math.round(drag.x + point.x - drag.pointer.x)
    const y = Math.round(drag.y + point.y - drag.pointer.y)
    if (![x, y].every(value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647)) {
      drag = null
      return
    }
    window.setPosition(x, y)
  })
  on('vidu-avatar:drag-end', event => {
    if (ownedWindow(event)) drag = null
  })
  return {
    cancel() { drag = null },
    dispose() { drag = null; registrations.forEach(remove => remove()) },
  }
}
