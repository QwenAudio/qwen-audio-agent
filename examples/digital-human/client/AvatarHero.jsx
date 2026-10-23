import { useState } from 'react'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import './avatar-hero.css'

// DHAV paints paired I420 frames into the canvas. The video surface is reserved
// for renderer adapters that own an RTC media track; neither changes Gateway.
export default function AvatarHero({ avatar, personaId }) {
  const {
    state, playback, avatarState, error,
    canvasRef, videoRef, frameCount, send, clearError,
  } = avatar

  const [draft, setDraft] = useState('')
  const visual = avatarVisualState(avatar)
  const dot = avatarStatusDot(visual)

  const ready = state === 'connected'
  const showVideo = frameCount > 0 && visual !== 'audio_only'

  const submit = event => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !ready) return
    if (send(text)) setDraft('')
  }

  return (
    <div
      className="hero avatar-hero"
      data-testid="avatar-stage"
      data-connection={state}
      data-playback={playback}
      data-avatar-state={avatarState?.state || ''}
      data-visual={visual}
      data-frame-count={frameCount}
    >
      <div className="avatar-viewport" data-visual={visual}>
        <canvas
          ref={canvasRef}
          className="avatar-video"
          data-testid="avatar-canvas"
          data-active={showVideo ? 'true' : 'false'}
          aria-label="数字人画面"
        />
        <video
          ref={videoRef}
          className="avatar-rtc-video"
          data-testid="avatar-video"
          playsInline
        />
        {!showVideo && (
          <div className="avatar-placeholder">
            <span className={`orb ${dot}`} />
            <p>
              {visual === 'audio_only'
                ? '头像不可用，已降级为纯音频'
                : ready
                  ? '说话或输入文字开始'
                  : state === 'connecting' ? '正在连接数字人…' : '点击「连接数字人」开始'}
            </p>
          </div>
        )}
      </div>

      <p className="avatar-tagline">DIGITAL HUMAN · {personaId}</p>

      {error && (
        <div className="avatar-error" role="status" data-testid="avatar-error">
          <span>{error}</span>
          <button type="button" className="link" onClick={clearError}>收起</button>
        </div>
      )}

      <form className="avatar-composer" onSubmit={submit}>
        <input
          className="avatar-input"
          value={draft}
          data-testid="avatar-input"
          placeholder="输入文字，回车发送"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault()
              submit(event)
            }
          }}
        />
        <button
          type="submit"
          className="ghost"
          data-testid="avatar-send"
          disabled={!ready || !draft.trim()}
        >
          发送
        </button>      </form>
    </div>
  )
}
