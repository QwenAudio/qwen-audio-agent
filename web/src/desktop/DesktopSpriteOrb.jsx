import { useEffect, useRef, useState } from 'react'
import {
  frameAtElapsed,
  frameRect,
  resolveAnimations,
  spritePlaybackSelection,
  spriteGeometry,
} from './sprite-orb.js'

// 精灵皮肤渲染器：从同源 skins/<id>/ 加载 Codex pet 包，canvas 直接
// 从整张 spritesheet 裁帧绘制。状态机与窗口交互都在组件外层，
// 这里只负责把共享的语音状态翻译成精灵动画。
export default function DesktopSpriteOrb({
  skin,
  state,
  baseWorking = false,
  dragDirection = '',
  cue = null,
  onCueComplete,
  onError,
}) {
  const canvasRef = useRef(null)
  const onErrorRef = useRef(onError)
  const onCueCompleteRef = useRef(onCueComplete)
  const playbackRef = useRef(null)
  const [assets, setAssets] = useState(null)
  onErrorRef.current = onError
  onCueCompleteRef.current = onCueComplete

  useEffect(() => {
    let cancelled = false
    setAssets(null)
    const fail = error => {
      if (!cancelled) onErrorRef.current?.(error)
    }
    fetch(`skins/${encodeURIComponent(skin)}/pet.json`)
      .then(response => {
        if (!response.ok) throw new Error(`皮肤 ${skin} 不存在`)
        return response.json()
      })
      .then(manifest => {
        const geometry = spriteGeometry(manifest)
        if (!geometry) throw new Error(`皮肤 ${skin} 的网格定义非法`)
        const animations = resolveAnimations(manifest, geometry.frameCount)
        const spritesheet = String(
          manifest.spritesheetPath || 'spritesheet.webp',
        )
        const image = new Image()
        image.decoding = 'async'
        image.onload = () => {
          if (cancelled) return
          if (
            image.naturalWidth !== geometry.width * geometry.columns
            || image.naturalHeight !== geometry.height * geometry.rows
          ) {
            fail(new Error(`皮肤 ${skin} 的贴图尺寸与网格不符`))
            return
          }
          setAssets({ image, geometry, animations })
        }
        image.onerror = () => fail(new Error(`皮肤 ${skin} 的贴图加载失败`))
        image.src = `skins/${encodeURIComponent(skin)}/${spritesheet}`
      })
      .catch(fail)
    return () => {
      cancelled = true
    }
  }, [skin])

  const playback = spritePlaybackSelection({
    state,
    baseWorking,
    dragDirection,
    cue,
  })
  playbackRef.current = playback

  useEffect(() => {
    if (!assets) return undefined
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!context) return undefined
    const { image, geometry, animations } = assets
    const activePlayback = playbackRef.current
    const selected = animations[activePlayback.name] || animations.idle
    let track = {
      ...selected,
      loopStart: activePlayback.loop ? 0 : null,
      fallback: 'idle',
    }
    let startedAt = performance.now()
    let timer = 0
    let completed = false
    const draw = () => {
      let frame = frameAtElapsed(track, performance.now() - startedAt)
      if (!frame) {
        if (!completed) {
          completed = true
          if (activePlayback.completion === 'cue') {
            onCueCompleteRef.current?.(activePlayback.completionId)
          }
        }
        const fallbackName = playbackRef.current?.fallback || activePlayback.fallback
        const fallback = animations[fallbackName] || animations.idle
        track = {
          ...fallback,
          loopStart: 0,
          fallback: 'idle',
        }
        startedAt = performance.now()
        frame = frameAtElapsed(track, 0)
        if (!frame) return
      }
      const source = frameRect(geometry, frame.spriteIndex)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.imageSmoothingEnabled = false
      context.drawImage(
        image,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        canvas.width,
        canvas.height,
      )
      timer = setTimeout(draw, Math.max(16, frame.remainingMs))
    }
    draw()
    return () => clearTimeout(timer)
  }, [
    assets,
    playback.key,
  ])

  if (!assets) return <div className="stage sprite-orb" />
  return (
    <div className="stage sprite-orb">
      <canvas
        ref={canvasRef}
        className="sprite-orb-canvas"
        width={assets.geometry.width}
        height={assets.geometry.height}
      />
    </div>
  )
}
