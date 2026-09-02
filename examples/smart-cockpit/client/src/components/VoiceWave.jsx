import { useEffect, useRef } from 'react'

const COLORS = {
  base: [139, 190, 201],
  baseSoft: [202, 229, 235],
  user: [50, 177, 161],
  userSoft: [126, 218, 207],
  thinking: [91, 148, 214],
  thinkingSoft: [139, 190, 201],
  system: [196, 168, 95],
  systemSoft: [224, 202, 143],
  error: [229, 186, 53],
  errorSoft: [245, 220, 128],
}

const STATE_STYLE = {
  idle: { speed: 0.00006, color: COLORS.base, accent: COLORS.baseSoft, direction: 1 },
  listening: { speed: 0.00048, color: COLORS.user, accent: COLORS.userSoft, direction: 1 },
  thinking: { speed: 0.00314, color: COLORS.thinking, accent: COLORS.thinkingSoft, direction: 1 },
  speaking: { speed: 0.00048, color: COLORS.system, accent: COLORS.systemSoft, direction: -1 },
  error: { speed: 0.0002, color: COLORS.error, accent: COLORS.errorSoft, direction: 1 },
}

const PROGRESS_STYLE = {
  searching_destination: { speed: 0.00068, color: COLORS.user, accent: COLORS.thinkingSoft, direction: 1, activity: 0.66 },
  searching_waypoint: { speed: 0.00068, color: COLORS.user, accent: COLORS.thinkingSoft, direction: 1, activity: 0.66 },
  destination_locked: { speed: 0.00052, color: COLORS.user, accent: COLORS.systemSoft, direction: -1, activity: 0.58, routeNodes: true },
  waypoint_locked: { speed: 0.00052, color: COLORS.user, accent: COLORS.systemSoft, direction: -1, activity: 0.58, routeNodes: true },
  planning_route: { speed: 0.0046, color: COLORS.thinking, accent: COLORS.systemSoft, direction: 1, activity: 0.74, oscillate: true, routeNodes: true },
  route_ready: { speed: 0.00052, color: COLORS.system, accent: COLORS.systemSoft, direction: -1, activity: 0.58, routeNodes: true },
  navigation_started: { speed: 0.00052, color: COLORS.system, accent: COLORS.systemSoft, direction: -1, activity: 0.58, routeNodes: true },
  flashbuy_searching: { speed: 0.00072, color: [242, 133, 50], accent: COLORS.userSoft, direction: 1, activity: 0.68 },
  flashbuy_results_ready: { speed: 0.0005, color: [242, 133, 50], accent: COLORS.userSoft, direction: -1, activity: 0.54 },
  flashbuy_adding: { speed: 0.00058, color: [242, 133, 50], accent: [255, 197, 97], direction: 1, activity: 0.62 },
  flashbuy_previewing: { speed: 0.0038, color: COLORS.thinking, accent: [255, 197, 97], direction: 1, activity: 0.72, oscillate: true },
  flashbuy_ordering: { speed: 0.00066, color: [242, 133, 50], accent: COLORS.systemSoft, direction: -1, activity: 0.68 },
  flashbuy_order_completed: { speed: 0.00044, color: COLORS.system, accent: [255, 197, 97], direction: -1, activity: 0.56 },
}

function rgba([r, g, b], alpha) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function wrap(value) {
  return ((value % 1) + 1) % 1
}

function mixColor(a, b, weight) {
  return [
    Math.round(a[0] * (1 - weight) + b[0] * weight),
    Math.round(a[1] * (1 - weight) + b[1] * weight),
    Math.round(a[2] * (1 - weight) + b[2] * weight),
  ]
}

function thinkingColor(position, soft = false) {
  const left = soft ? COLORS.userSoft : COLORS.user
  const center = soft ? COLORS.thinkingSoft : COLORS.thinking
  const right = soft ? COLORS.systemSoft : COLORS.system

  if (position < 0.5) {
    return mixColor(left, center, position / 0.5)
  }
  return mixColor(center, right, (position - 0.5) / 0.5)
}

export default function VoiceWave({ state = 'idle', muted = true, progress = null, inputLevel = 0, outputLevel = 0 }) {
  const canvasRef = useRef(null)
  const animationRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const ctx = canvas.getContext('2d')
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * ratio))
      canvas.height = Math.max(1, Math.floor(rect.height * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    const draw = (time) => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      ctx.clearRect(0, 0, width, height)

      const progressStyle = !muted && progress?.stage ? PROGRESS_STYLE[progress.stage] : null
      const style = progressStyle || STATE_STYLE[state] || STATE_STYLE.idle
      const levelSource = state === 'speaking' ? outputLevel : inputLevel
      const level = clamp(levelSource * 1.35)
      const idlePulse = 0.5 + 0.5 * Math.sin(time * 0.0012)
      const isAmbient = muted || (state === 'idle' && !progressStyle)
      const activity = progressStyle ? clamp(progressStyle.activity + level * 0.42) : (isAmbient ? 0.26 + idlePulse * 0.12 : clamp(0.42 + level * 0.78))
      const sweepProgress = progressStyle?.oscillate
        ? 0.5 + 0.5 * Math.sin(time * style.speed)
        : state === 'thinking'
        ? 0.5 + 0.5 * Math.sin(time * style.speed)
        : wrap(time * style.speed * style.direction)
      const movingDirection = progressStyle?.oscillate
        ? (Math.cos(time * style.speed) >= 0 ? 1 : -1)
        : state === 'thinking'
        ? (Math.cos(time * style.speed) >= 0 ? 1 : -1)
        : style.direction
      const activeColor = progressStyle?.oscillate
        ? thinkingColor(sweepProgress)
        : state === 'thinking'
        ? thinkingColor(sweepProgress)
        : style.color
      const activeAccent = progressStyle?.oscillate
        ? thinkingColor(sweepProgress, true)
        : state === 'thinking'
        ? thinkingColor(sweepProgress, true)
        : style.accent

      const drawField = (x, y, radiusX, radiusY, color, alpha) => {
        const radius = Math.max(radiusX, radiusY)
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(radiusX / radius, radiusY / radius)
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius)
        gradient.addColorStop(0, rgba(color, alpha))
        gradient.addColorStop(0.36, rgba(color, alpha * 0.54))
        gradient.addColorStop(0.72, rgba(color, alpha * 0.14))
        gradient.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.arc(0, 0, radius, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }

      const lowerY = height * 1.03
      const dynamicX = width * sweepProgress
      const trailX = width * wrap(sweepProgress - movingDirection * 0.24)
      const leftPulse = state === 'thinking' ? 0.5 + 0.5 * Math.sin(time * 0.0017) : 1
      const rightPulse = state === 'thinking' ? 1 - leftPulse : 1

      drawField(width * 0.14, lowerY, width * 0.58, height * 0.9, COLORS.base, 0.16 + activity * 0.1 * leftPulse)
      drawField(width * 0.48, height * 1.03, width * 0.74, height * 0.72, COLORS.baseSoft, 0.12 + activity * 0.08)
      drawField(width * 0.9, lowerY, width * 0.62, height * 0.94, COLORS.userSoft, 0.12 + activity * 0.09 * rightPulse)

      if (!isAmbient) {
        const activeBoost = state === 'thinking' ? 0.08 : 0
        drawField(dynamicX, height * 0.88, width * (0.38 + activity * 0.24), height * (0.58 + activity * 0.2), activeColor, 0.34 + activity * 0.3 + activeBoost)
        drawField(trailX, height * 0.98, width * 0.44, height * 0.48, activeAccent, 0.2 + activity * 0.18 + activeBoost * 0.5)
        if (progressStyle?.routeNodes) {
          ;[0.24, 0.5, 0.76].forEach((node, index) => {
            const pulse = 0.55 + 0.45 * Math.sin(time * 0.004 + index * 1.4)
            drawField(width * node, height * 0.78, width * 0.08, height * 0.14, activeAccent, 0.08 + pulse * 0.16)
          })
        }
      } else {
        drawField(width * (0.4 + idlePulse * 0.2), height * 0.92, width * 0.56, height * 0.54, COLORS.baseSoft, 0.14 + activity * 0.12)
        drawField(width * (0.68 - idlePulse * 0.14), height * 1.02, width * 0.42, height * 0.42, COLORS.base, 0.08 + activity * 0.08)
      }

      const railY = height - 9
      const rail = ctx.createLinearGradient(0, railY, width, railY)
      rail.addColorStop(0, rgba(COLORS.base, 0.06))
      rail.addColorStop(0.32, rgba(COLORS.base, 0.16 + activity * 0.08))
      rail.addColorStop(0.68, rgba(COLORS.userSoft, 0.16 + activity * 0.08))
      rail.addColorStop(1, rgba(COLORS.base, 0.06))
      ctx.fillStyle = rail
      ctx.beginPath()
      ctx.roundRect(18, railY - 1, width - 36, 6, 3)
      ctx.fill()

      if (!isAmbient) {
        const segmentWidth = width * (0.28 + activity * 0.2)
        const segmentX = dynamicX - segmentWidth / 2
        const segment = ctx.createLinearGradient(segmentX, railY, segmentX + segmentWidth, railY)
        segment.addColorStop(0, rgba(activeColor, 0))
        segment.addColorStop(0.5, rgba(activeAccent, 0.62 + activity * 0.34))
        segment.addColorStop(1, rgba(activeColor, 0))
        ctx.fillStyle = segment
        ctx.beginPath()
        ctx.roundRect(segmentX, railY - 4, segmentWidth, 11, 5.5)
        ctx.fill()
      } else {
        const ambientSweep = wrap(time * 0.00012)
        const ambientWidth = width * 0.22
        const ambientX = width * ambientSweep - ambientWidth / 2
        const ambientHeight = 16 + idlePulse * 8
        const ambientSegment = ctx.createLinearGradient(ambientX, railY, ambientX + ambientWidth, railY)
        ambientSegment.addColorStop(0, rgba(COLORS.baseSoft, 0))
        ambientSegment.addColorStop(0.5, rgba(COLORS.baseSoft, 0.58 + idlePulse * 0.12))
        ambientSegment.addColorStop(1, rgba(COLORS.baseSoft, 0))
        ctx.fillStyle = ambientSegment
        ctx.beginPath()
        ctx.roundRect(ambientX, railY - ambientHeight / 2, ambientWidth, ambientHeight, ambientHeight / 2)
        ctx.fill()
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    animationRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animationRef.current)
    }
  }, [inputLevel, muted, outputLevel, progress, state])

  return <canvas className="voice-wave" ref={canvasRef} aria-hidden="true" />
}
