import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CAMERA_FRAME_INTERVAL_MS,
  CAMERA_IMAGE_TOO_LARGE,
  blobToBase64,
  captureCameraFrame,
  stopCameraStream,
} from './camera-input.js'
import { t } from './i18n.js'

export default function VisualStreamControl({
  available = false,
  inputEnabled = false,
  connectionState = 'connected',
  onFrame,
}) {
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const [error, setError] = useState('')
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const streamingRef = useRef(false)

  const stopStreaming = useCallback(() => {
    streamingRef.current = false
    setStreaming(false)
    setFrameCount(0)
  }, [])

  const closeCamera = useCallback(() => {
    stopStreaming()
    stopCameraStream(streamRef.current)
    streamRef.current = null
    if (videoRef.current) {
      videoRef.current.pause?.()
      videoRef.current.srcObject = null
    }
    setCameraReady(false)
    setCameraOpen(false)
  }, [stopStreaming])

  useEffect(() => {
    if (!cameraOpen || !streamRef.current || !videoRef.current) return undefined
    const video = videoRef.current
    const stream = streamRef.current
    video.srcObject = stream
    void video.play().catch(() => {})
    return () => {
      if (video.srcObject === stream) video.srcObject = null
    }
  }, [cameraOpen])

  useEffect(() => {
    if (!cameraOpen || !streamRef.current) return undefined
    const stream = streamRef.current
    const onEnded = () => {
      setError(t('相机连接已断开'))
      closeCamera()
    }
    const tracks = stream.getTracks?.() || []
    tracks.forEach(track => track.addEventListener?.('ended', onEnded))
    return () => tracks.forEach(track => track.removeEventListener?.('ended', onEnded))
  }, [cameraOpen, closeCamera])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) return
      closeCamera()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [closeCamera])

  useEffect(() => {
    if (!cameraOpen) return
    if (
      !available
      || ['unavailable', 'disconnected', 'hidden'].includes(connectionState)
    ) closeCamera()
  }, [available, cameraOpen, closeCamera, connectionState])

  useEffect(() => {
    if (!inputEnabled && streamingRef.current) stopStreaming()
  }, [inputEnabled, stopStreaming])

  useEffect(() => () => closeCamera(), [closeCamera])

  useEffect(() => {
    if (!streaming || !cameraReady) return undefined
    let disposed = false
    let capturing = false
    const capture = async () => {
      if (disposed || capturing || !streamingRef.current || !videoRef.current) return
      capturing = true
      try {
        const blob = await captureCameraFrame(videoRef.current)
        const image = await blobToBase64(blob)
        if (disposed || !streamingRef.current) return
        if (onFrame?.(image, Date.now()) === false) {
          setError(t('视觉输入连接不可用'))
          closeCamera()
          return
        }
        setFrameCount(value => value + 1)
      } catch (reason) {
        setError(reason?.message === CAMERA_IMAGE_TOO_LARGE
          ? t('视觉帧超过大小限制')
          : t('无法采集视觉画面'))
        closeCamera()
      } finally {
        capturing = false
      }
    }
    void capture()
    const timer = setInterval(capture, CAMERA_FRAME_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [cameraReady, closeCamera, onFrame, streaming])

  const openCamera = useCallback(async () => {
    if (!available || streamRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t('当前浏览器无法使用相机'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      streamRef.current = stream
      setCameraReady(false)
      setCameraOpen(true)
      setError('')
    } catch {
      setError(t('无法打开相机'))
    }
  }, [available])

  const startStreaming = useCallback(() => {
    if (!cameraReady || !available || !inputEnabled) return
    streamingRef.current = true
    setStreaming(true)
    setError('')
  }, [available, cameraReady, inputEnabled])

  return <>
    <button
      className="composer-camera"
      type="button"
      title={t('打开相机预览')}
      aria-label={t('开启实时视觉')}
      disabled={!available}
      onClick={() => void openCamera()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 8.5h3l1.3-2h5.4l1.3 2h3v10H5z" />
        <circle cx="12" cy="13.5" r="3.2" />
      </svg>
    </button>
    {cameraOpen && <div
      className="camera-stream"
      role="dialog"
      aria-modal="true"
      aria-label={t('实时视觉')}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={() => setCameraReady(true)}
        aria-label={t('相机预览')}
      />
      <small className={`camera-status${streaming ? ' active' : ''}`} role="status">
        <span className="camera-status-dot" aria-hidden="true" />
        {streaming
          ? t('实时视觉已开启 · 已发送 {count} 帧', { count: frameCount })
          : inputEnabled
            ? t('画面仅在开启实时视觉后发送')
            : t('请先开启麦克风，再开始实时视觉')}
      </small>
      <div className="camera-actions">
        <button type="button" className="ghost" onClick={closeCamera}>
          {t('关闭相机')}
        </button>
        {streaming
          ? <button type="button" className="camera-live active" onClick={stopStreaming}>
              {t('停止实时视觉')}
            </button>
          : <button
              type="button"
              className="composer-send"
              disabled={!cameraReady}
              onClick={startStreaming}
            >
              {t('开始实时视觉')}
            </button>}
      </div>
    </div>}
    {error && <small className="composer-error" role="alert">{error}</small>}
  </>
}
