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
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointerId !== null) return
    pointerId = event.pointerId
    element.setPointerCapture(pointerId)
    element.classList.add('dragging')
    bridge.startDrag(point(event))
    event.preventDefault()
  })
  element.addEventListener('pointermove', event => {
    if (event.pointerId === pointerId) bridge.moveDrag(point(event))
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, finish)
  window.addEventListener('blur', finish)
}
