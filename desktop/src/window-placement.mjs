const ORB_SIZE = Object.freeze({ width: 172, height: 170 })
const DEFAULT_SIZES = Object.freeze({
  settings: { width: 540, height: 860 },
  repair: { width: 640, height: 720 },
})
const WINDOW_MARGIN = 24
const TITLE_BAR_VISIBLE_HEIGHT = 32

function validRectangle(value) {
  return Boolean(value)
    && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
    && value.width > 0
    && value.height > 0
}

function workArea(display) {
  if (!validRectangle(display?.workArea)) {
    throw new Error('A display with a valid work area is required')
  }
  return display.workArea
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

function squaredDistanceToRectangle(point, rectangle) {
  const right = rectangle.x + rectangle.width
  const bottom = rectangle.y + rectangle.height
  const dx = point.x < rectangle.x
    ? rectangle.x - point.x
    : point.x > right ? point.x - right : 0
  const dy = point.y < rectangle.y
    ? rectangle.y - point.y
    : point.y > bottom ? point.y - bottom : 0
  return dx * dx + dy * dy
}

function nearestDisplay(bounds, displays) {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  return displays.reduce((nearest, display) => (
    squaredDistanceToRectangle(center, workArea(display))
      < squaredDistanceToRectangle(center, workArea(nearest))
      ? display
      : nearest
  ))
}

export function defaultWindowBounds({ kind, display } = {}) {
  const area = workArea(display)
  if (kind === 'orb') {
    return {
      x: area.x + area.width - ORB_SIZE.width - WINDOW_MARGIN,
      y: area.y + WINDOW_MARGIN,
      ...ORB_SIZE,
    }
  }
  const size = DEFAULT_SIZES[kind]
  if (!size) throw new Error(`Unsupported desktop window kind: ${kind}`)
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

export function clampWindowBounds({ kind, bounds, displays } = {}) {
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new Error('At least one current display is required')
  }
  for (const display of displays) workArea(display)
  if (!validRectangle(bounds)) {
    return defaultWindowBounds({ kind, display: displays[0] })
  }
  const display = nearestDisplay(bounds, displays)
  const area = workArea(display)
  if (kind === 'orb') {
    return {
      x: Math.round(clamp(
        bounds.x,
        area.x,
        area.x + area.width - ORB_SIZE.width,
      )),
      y: Math.round(clamp(
        bounds.y,
        area.y,
        area.y + area.height - ORB_SIZE.height,
      )),
      ...ORB_SIZE,
    }
  }
  if (!DEFAULT_SIZES[kind]) {
    throw new Error(`Unsupported desktop window kind: ${kind}`)
  }
  const width = Math.min(Math.round(bounds.width), area.width)
  const height = Math.min(Math.round(bounds.height), area.height)
  return {
    x: Math.round(clamp(
      bounds.x,
      area.x,
      area.x + area.width - width,
    )),
    y: Math.round(clamp(
      bounds.y,
      area.y,
      area.y + area.height - Math.min(TITLE_BAR_VISIBLE_HEIGHT, height),
    )),
    width,
    height,
  }
}
