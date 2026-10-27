export function installWindowDrag(element, bridge) {
  if (!element || !bridge?.startDrag) return
  let pointerId = null
  const point = event => ({ x: event.screenX, y: event.screenY })
  const finish = () => {
    if (pointerId === null) return
    const id = pointerId
    pointerId = null
    bridge.endDrag()
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id)
    element.classList.remove('dragging')
  }
  const start = event => {
    if (event.button !== 0 || pointerId !== null) return
    pointerId = event.pointerId
    element.setPointerCapture(pointerId)
    element.classList.add('dragging')
    bridge.startDrag(point(event))
    event.preventDefault()
  }
  const move = event => {
    if (event.pointerId === pointerId) bridge.moveDrag(point(event))
  }
  const endEvents = ['pointerup', 'pointercancel', 'lostpointercapture']
  element.addEventListener('pointerdown', start)
  element.addEventListener('pointermove', move)
  for (const type of endEvents) element.addEventListener(type, finish)
  window.addEventListener('blur', finish)
  return () => {
    finish()
    element.removeEventListener('pointerdown', start)
    element.removeEventListener('pointermove', move)
    for (const type of endEvents) element.removeEventListener(type, finish)
    window.removeEventListener('blur', finish)
  }
}
