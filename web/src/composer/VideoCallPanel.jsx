import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CAMERA_FRAME_INTERVAL_MS,
  CAMERA_IMAGE_TOO_LARGE,
  blobToBase64,
  captureCameraFrame,
  stopCameraStream,
} from './camera-input.js'
import { t } from '../i18n.js'

const WIDE_VISUAL_DOCK_QUERY = '(min-width: 1400px)'

function CameraIcon({ disabled = false }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="6" width="12" height="12" rx="3" />
    <path d="m15 10 6-3v10l-6-3" />
    {disabled && <path d="m3 3 18 18" />}
  </svg>
}

// Mounted only after an explicit video-call gesture. Owns camera capture, not
// microphone or Realtime lifecycle; disabling video leaves voice untouched.
export default function VideoCallPanel({
  available = false,
  connectionState = 'connected',
  onFrame,
  onStop,
  onStateChange,
  onClose,
}) {
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [stream, setStream] = useState(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const [error, setError] = useState('')
  const [wideDock, setWideDock] = useState(() => (
    typeof window !== 'undefined'
      && window.matchMedia?.(WIDE_VISUAL_DOCK_QUERY).matches === true
  ))
  const videoRef = useRef(null)
  const streamingRef = useRef(false)
  const transportReady = available && connectionState === 'connected'
  const streaming = cameraEnabled && cameraReady && transportReady
  streamingRef.current = streaming

  useEffect(() => {
    const query = window.matchMedia?.(WIDE_VISUAL_DOCK_QUERY)
    if (!query) return undefined
    const update = event => setWideDock(event.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  useEffect(() => {
    if (!cameraEnabled) return undefined
    let disposed = false
    let acquired = null
    const ended = () => {
      if (disposed) return
      streamingRef.current = false
      setError(t('相机连接已断开'))
      setCameraEnabled(false)
    }
    const acquire = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(t('当前浏览器无法使用相机'))
        }
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        // Permission prompts can outlive the panel or a camera-off gesture.
        if (disposed) { stopCameraStream(acquired); return }
        acquired.getTracks().forEach(track => track.addEventListener('ended', ended))
        setStream(acquired)
      } catch {
        if (disposed) return
        setError(t('无法打开相机'))
        setCameraEnabled(false)
      }
    }
    void acquire()
    return () => {
      disposed = true
      acquired?.getTracks().forEach(track => track.removeEventListener('ended', ended))
      stopCameraStream(acquired)
      setStream(null)
      setCameraReady(false)
    }
  }, [cameraEnabled])

  useEffect(() => {
    const video = videoRef.current
    if (!stream || !video) return undefined
    video.srcObject = stream
    void video.play().catch(() => {})
    return () => { video.srcObject = null }
  }, [stream, wideDock])

  useEffect(() => {
    if (!streaming) return undefined
    let disposed = false
    let capturing = false
    let reportedActive = false
    const capture = async () => {
      if (disposed || capturing || !streamingRef.current || !videoRef.current) return
      // Moving between the dock and inline layout remounts the video element.
      // Wait for its first frame rather than treating metadata loading as failure.
      if (videoRef.current.readyState < 2 || !videoRef.current.videoWidth) return
      capturing = true
      try {
        const blob = await captureCameraFrame(videoRef.current)
        const image = await blobToBase64(blob)
        if (disposed || !streamingRef.current) return
        if (onFrame?.(image, Date.now()) === false) {
          if (reportedActive) onStateChange?.(false)
          reportedActive = false
          setError(t('视觉输入连接不可用'))
          return
        }
        if (!reportedActive) onStateChange?.(true)
        reportedActive = true
        setError('')
        setFrameCount(value => value + 1)
      } catch (reason) {
        if (disposed) return
        setError(reason?.message === CAMERA_IMAGE_TOO_LARGE
          ? t('视觉帧超过大小限制')
          : t('无法采集视觉画面'))
        setCameraEnabled(false)
      } finally {
        capturing = false
      }
    }
    void capture()
    const timer = setInterval(capture, CAMERA_FRAME_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      onStop?.()
      onStateChange?.(false)
    }
  }, [streaming, onFrame, onStop, onStateChange])

  const toggleCamera = () => {
    streamingRef.current = false
    setCameraEnabled(value => !value)
    setFrameCount(0)
    setError('')
  }

  const panel = <div
    className={`camera-stream${wideDock ? ' camera-stream-docked' : ''}`}
    role="region"
    aria-label={t('视频通话')}
  >
    <div className="camera-heading">
      <span>{t('视频通话')}</span>
      <button type="button" className="camera-icon-button"
        title={t('关闭视频，保留语音')} aria-label={t('关闭视频，保留语音')}
        onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
      </button>
    </div>
    {cameraEnabled
      ? <video ref={videoRef} autoPlay playsInline muted
          onLoadedMetadata={() => setCameraReady(true)} aria-label={t('相机预览')} />
      : <div className="camera-placeholder"><CameraIcon disabled /><span>{t('摄像头已关闭')}</span></div>}
    <div className="camera-controls">
      <small className={`camera-status${streaming ? ' active' : ''}`} role="status">
        <span className="camera-status-dot" aria-hidden="true" />
        {!cameraEnabled ? t('摄像头已关闭')
          : !cameraReady ? t('正在开启摄像头')
            : streaming ? t('实时视觉已开启 · 已发送 {count} 帧', { count: frameCount })
              : t('实时视觉已暂停，连接恢复后将自动继续')}
      </small>
      <button type="button" className={`camera-icon-button${cameraEnabled ? ' active' : ''}`}
        aria-label={cameraEnabled ? t('关闭摄像头') : t('开启摄像头')}
        title={cameraEnabled ? t('关闭摄像头') : t('开启摄像头')}
        aria-pressed={cameraEnabled} onClick={toggleCamera}>
        <CameraIcon disabled={!cameraEnabled} />
      </button>
    </div>
    {error && <small className="composer-error" role="alert">{error}</small>}
  </div>

  return wideDock ? createPortal(panel, document.body) : panel
}
