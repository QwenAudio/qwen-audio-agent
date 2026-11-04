import { useState } from 'react'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import './avatar-hero.css'

// DHAV paints paired I420 frames into the canvas. The video surface is reserved
// for renderer adapters that own an RTC media track; neither changes Gateway.
export default function AvatarHero({ avatar, personaId, rendererId = 'dhav', referenceImage }) {
  const {
    state, playback, avatarState, error,
    canvasRef, videoRef, frameCount, idlePainted, send, clearError,
  } = avatar

  const [draft, setDraft] = useState('')
  const [failedImage, setFailedImage] = useState(null)
  const visual = avatarVisualState(avatar)
  const dot = avatarStatusDot(visual)

  const ready = state === 'connected'
  // Idle animation paints without a reply, so it never advances frameCount;
  // either signal means the canvas has real pixels. Vidu owns a continuous RTC
  // track and never reports idle frames, so its liveness check still governs.
  const showVideo = (frameCount > 0 || idlePainted) && visual !== 'audio_only'
    && (rendererId !== 'vidu' || (videoRef.current?.srcObject && !videoRef.current.paused && videoRef.current.readyState >= 2))
  const showReference = rendererId === 'vidu' && referenceImage && failedImage !== referenceImage && !showVideo

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
      data-idle-painted={idlePainted ? 'true' : 'false'}
    >
      <div className="avatar-viewport" data-visual={visual}>
        <canvas
          ref={canvasRef}
          className="avatar-video"
          data-testid="avatar-canvas"
          data-active={showVideo && rendererId === 'dhav' ? 'true' : 'false'}
          aria-label="数字人画面"
        />
        {rendererId === 'vidu' && referenceImage && failedImage !== referenceImage && (
          <img className="avatar-reference" data-testid="avatar-reference" src={referenceImage}
            alt="数字人参考图片" data-active={showReference ? 'true' : 'false'}
            onError={() => setFailedImage(referenceImage)} />
        )}
        <video
          ref={videoRef}
          className="avatar-rtc-video"
          data-testid="avatar-video"
          data-active={showVideo && rendererId === 'vidu' ? 'true' : 'false'}
          playsInline
        />
        {!showVideo && !showReference && (
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
