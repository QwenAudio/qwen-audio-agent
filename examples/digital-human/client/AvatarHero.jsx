import { useEffect, useState } from 'react'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import './avatar-hero.css'

// The avatar stage of this example's standalone SPA: the centred <video>
// downlink plus a minimal text turn injector. The spoken transcript lives in the
// sibling `.messages` panel (App.jsx), not as an overlay here. Task, permission
// and history panels deliberately do not exist in this example.
//
// `avatar` is the useWebRtcVoice transport owned by App so the header status
// light and this stage share one WebRTC connection.
export default function AvatarHero({ avatar, personaId }) {
  const {
    state, playback, avatarState, error,
    videoRef, audioRef, send, clearError,
  } = avatar

  const [draft, setDraft] = useState('')
  const [frameCount, setFrameCount] = useState(0)
  const [videoReady, setVideoReady] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    let handle = 0
    let frames = 0
    const supportsCallback = typeof video.requestVideoFrameCallback === 'function'
    const onFrame = () => {
      frames += 1
      setFrameCount(frames)
      setVideoReady(true)
      if (supportsCallback) handle = video.requestVideoFrameCallback(onFrame)
    }
    if (supportsCallback) handle = video.requestVideoFrameCallback(onFrame)
    const onPlaying = () => setVideoReady(true)
    const onEmptied = () => { setVideoReady(false); setFrameCount(0) }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('emptied', onEmptied)
    return () => {
      if (supportsCallback && handle) video.cancelVideoFrameCallback(handle)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('emptied', onEmptied)
    }
  }, [videoRef])

  const visual = avatarVisualState({ state, playback, avatarState })
  const dot = avatarStatusDot(visual)

  const ready = state === 'connected'
  const showVideo = videoReady && visual !== 'audio_only'

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
      <audio ref={audioRef} className="avatar-audio" />

      <div className="avatar-viewport" data-visual={visual}>
        <video
          ref={videoRef}
          className="avatar-video"
          data-testid="avatar-video"
          data-active={showVideo ? 'true' : 'false'}
          playsInline
          muted
          autoPlay
        />
        {!showVideo && (
          <div className="avatar-placeholder">
            <span className={`orb ${dot}`} />
            <p>
              {visual === 'audio_only'
                ? '头像不可用，已降级为纯音频'
                : ready
                  ? '说话或输入文字开始'
                  : '正在连接数字人…'}
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
