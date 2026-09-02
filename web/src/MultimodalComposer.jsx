import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_INPUT_FILE_BYTES,
  createInputFilePart,
  inputPartLabel,
  withAttachmentAnchors,
} from '../../shared/input-parts.mjs'
import { t } from './i18n.js'
import {
  CAMERA_IMAGE_TOO_LARGE,
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_BYTES,
  OBSERVATION_MAX_FRAMES,
  appendRecentObservationFrame,
  blobToBase64,
  captureCameraFrame,
  stopCameraStream,
} from './camera-input.js'

function filePart(file, index, sourceType = 'file') {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_INPUT_FILE_BYTES) {
      reject(new Error(t('文件 {name} 超过 8 MB 限制', { name: file.name })))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error(t('无法读取文件')))
    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        part: createInputFilePart({
          mime: file.type || 'application/octet-stream',
          filename: file.name,
          url: String(reader.result || ''),
          sourceType,
        }, index),
      })
    }
    reader.readAsDataURL(file)
  })
}

export default function MultimodalComposer({
  onSend,
  onObservationStart,
  onObservationFrame,
  onObservationStop,
  observationAvailable = false,
  observationState = 'idle',
  connectionState = 'connected',
  compact = false,
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [observationRequested, setObservationRequested] = useState(false)
  const [observationFrameCount, setObservationFrameCount] = useState(0)
  const picker = useRef(null)
  const cameraVideo = useRef(null)
  const cameraStream = useRef(null)
  const observationRequestedRef = useRef(false)
  const observationFramesRef = useRef([])
  const observationSequenceRef = useRef(0)
  const previousObservationStateRef = useRef(observationState)
  const updateAttachments = useCallback(next => {
    setAttachments(next)
  }, [])

  const stopObservation = useCallback((reason = 'user') => {
    if (observationRequestedRef.current) onObservationStop?.(reason)
    observationRequestedRef.current = false
    observationFramesRef.current = []
    setObservationRequested(false)
    setObservationFrameCount(0)
  }, [onObservationStop])

  const closeCamera = useCallback((reason = 'user') => {
    stopObservation(reason)
    stopCameraStream(cameraStream.current)
    cameraStream.current = null
    if (cameraVideo.current) {
      cameraVideo.current.pause?.()
      cameraVideo.current.srcObject = null
    }
    setCameraReady(false)
    setCameraOpen(false)
  }, [stopObservation])

  useEffect(() => {
    if (!cameraOpen || !cameraStream.current || !cameraVideo.current) return undefined
    const video = cameraVideo.current
    const stream = cameraStream.current
    video.srcObject = stream
    void video.play().catch(() => {})
    return () => {
      if (video.srcObject === stream) video.srcObject = null
    }
  }, [cameraOpen])

  useEffect(() => {
    if (!cameraOpen || !cameraStream.current) return undefined
    const stream = cameraStream.current
    const onTrackEnded = () => closeCamera('camera_disconnected')
    const tracks = stream.getTracks?.() || []
    tracks.forEach(track => track.addEventListener?.('ended', onTrackEnded))
    return () => tracks.forEach(track => (
      track.removeEventListener?.('ended', onTrackEnded)
    ))
  }, [cameraOpen, closeCamera])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) closeCamera('page_hidden')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [closeCamera])

  useEffect(() => () => {
    if (observationRequestedRef.current) onObservationStop?.('unmount')
    observationRequestedRef.current = false
    observationFramesRef.current = []
    stopCameraStream(cameraStream.current)
  }, [onObservationStop])

  const startObservation = useCallback(() => {
    if (observationRequestedRef.current) return
    if (!observationAvailable) {
      setError(t('当前模型不支持画面观察'))
      return
    }
    if (!cameraReady || !cameraVideo.current) return
    if (onObservationStart && onObservationStart() === false) {
      setError(t('画面观察连接不可用'))
      return
    }
    observationRequestedRef.current = true
    setObservationRequested(true)
    setError('')
  }, [cameraReady, observationAvailable, onObservationStart])

  useEffect(() => {
    const previous = previousObservationStateRef.current
    previousObservationStateRef.current = observationState
    if (!observationRequestedRef.current) return
    if (!observationAvailable) {
      setError(t('当前模型不支持画面观察'))
      closeCamera('model_changed')
      return
    }
    if (['unavailable', 'hidden'].includes(connectionState)) {
      setError(t('画面观察连接不可用'))
      closeCamera('gateway_disconnected')
      return
    }
    if (observationState === 'unavailable') {
      setError(t('画面观察连接不可用'))
      closeCamera('provider_unavailable')
      return
    }
    if (
      observationState === 'idle'
      && ['starting', 'active', 'unavailable'].includes(previous)
    ) {
      closeCamera('observation_stopped')
    }
  }, [closeCamera, connectionState, observationAvailable, observationState])

  useEffect(() => {
    if (
      !observationRequested
      || observationState !== 'active'
      || !cameraReady
    ) return undefined
    let disposed = false
    let capturing = false
    const captureAndSend = async () => {
      const video = cameraVideo.current
      if (disposed || capturing || !video) return
      capturing = true
      try {
        const blob = await captureCameraFrame(video, {
          maxBytes: OBSERVATION_MAX_BYTES,
        })
        const image = await blobToBase64(blob)
        if (disposed || !observationRequestedRef.current) return
        const sequence = observationSequenceRef.current++
        const recent = appendRecentObservationFrame(
          observationFramesRef.current,
          { image, sequence },
          OBSERVATION_MAX_FRAMES,
        )
        observationFramesRef.current = recent
        setObservationFrameCount(recent.length)
        onObservationFrame?.(image, sequence)
      } catch (reason) {
        if (disposed) return
        setError(reason?.message === CAMERA_IMAGE_TOO_LARGE
          ? t('画面观察图片超过 256 KiB 限制')
          : t('画面观察捕获失败'))
        closeCamera('capture_error')
      } finally {
        capturing = false
      }
    }
    void captureAndSend()
    const timer = setInterval(captureAndSend, OBSERVATION_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [cameraReady, closeCamera, observationRequested, observationState, onObservationFrame])

  const openCamera = useCallback(async () => {
    if (cameraStream.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t('相机不可用'))
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
      cameraStream.current = stream
      setCameraReady(false)
      setCameraOpen(true)
      setError('')
    } catch {
      setError(t('无法打开相机'))
    }
  }, [])

  const addFiles = useCallback(async (fileList, sourceType = 'file') => {
    const files = [...fileList]
    if (!files.length) return
    try {
      const next = await Promise.all(files.map((file, index) => (
        filePart(file, attachments.length + index, sourceType)
      )))
      updateAttachments([...attachments, ...next])
      setError('')
      return true
    } catch (reason) {
      setError(reason?.message || String(reason))
      return false
    }
  }, [attachments, updateAttachments])

  const capturePhoto = useCallback(async () => {
    if (!cameraReady || !cameraVideo.current) return
    try {
      const blob = await captureCameraFrame(cameraVideo.current)
      const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })
      if (await addFiles([file], 'camera') && !observationRequestedRef.current) {
        closeCamera('photo_captured')
      }
    } catch (reason) {
      setError(reason?.message === CAMERA_IMAGE_TOO_LARGE
        ? t('照片超过 256 KiB 限制')
        : t('无法拍摄照片'))
    }
  }, [addFiles, cameraReady, closeCamera])

  const submit = event => {
    event.preventDefault()
    const content = text.trim()
    if (!content && !attachments.length) return
    const parts = withAttachmentAnchors([
      ...(content ? [{ type: 'text', text: content }] : []),
      ...attachments.map(item => item.part),
    ])
    if (!onSend(parts)) {
      setError(t('Gateway 尚未连接'))
      return
    }
    setText('')
    updateAttachments([])
    setError('')
  }

  return <form
    className="multimodal-composer"
    onSubmit={submit}
    onDragOver={event => event.preventDefault()}
    onDrop={event => {
      event.preventDefault()
      addFiles(event.dataTransfer.files)
    }}
  >
    {attachments.length > 0 && <div className="composer-attachments">
      {attachments.map((item, index) => <span className="composer-attachment" key={item.id}>
        <span>{inputPartLabel(item.part, index)}</span>
        <button
          type="button"
          aria-label={t('移除附件')}
          onClick={() => updateAttachments(attachments.filter(entry => entry.id !== item.id))}
        >×</button>
      </span>)}
    </div>}
    <div className="composer-row">
      <button
        className="composer-attach"
        type="button"
        title={t('添加图片或文件')}
        aria-label={t('添加图片或文件')}
        onClick={() => picker.current?.click()}
      >＋</button>
      <button
        className="composer-camera"
        type="button"
        title={t('拍照')}
        aria-label={t('拍照')}
        onClick={() => void openCamera()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 8.5h3l1.3-2h5.4l1.3 2h3v10H5z" />
          <circle cx="12" cy="13.5" r="3.2" />
        </svg>
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={event => {
          addFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <textarea
        value={text}
        rows="1"
        placeholder={compact
          ? t('输入文字或图片')
          : t('输入文字，或粘贴、拖入图片和文件')}
        onChange={event => setText(event.target.value)}
        onPaste={event => {
          const files = event.clipboardData?.files
          if (!files?.length) return
          event.preventDefault()
          addFiles(files, 'clipboard')
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) submit(event)
        }}
      />
      <button className="composer-send" type="submit">{t('发送')}</button>
    </div>
    {cameraOpen && <div className="camera-capture" role="dialog" aria-modal="true" aria-label={t('拍照')}>
      <video
        ref={cameraVideo}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={() => setCameraReady(true)}
        aria-label={t('相机预览')}
      />
      {observationRequested && <small className="camera-observation-status">
        {observationState !== 'active'
          ? t('正在启动画面观察')
          : t('连续观察中：最近 {count}/8 帧', { count: observationFrameCount })}
      </small>}
      <div className="camera-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => closeCamera('user')}
        >{observationRequested ? t('关闭相机') : t('取消')}</button>
        {!observationRequested && <button
          type="button"
          className="camera-observation"
          disabled={!cameraReady || !observationAvailable}
          title={observationAvailable ? t('连续观察') : t('当前模型不支持画面观察')}
          onClick={startObservation}
        >{t('连续观察')}</button>}
        {observationRequested && <button
          type="button"
          className="camera-observation active"
          onClick={() => stopObservation('user')}
        >{t('停止观察')}</button>}
        <button
          type="button"
          className="composer-send"
          disabled={!cameraReady}
          onClick={() => void capturePhoto()}
        >
          {t('拍摄')}
        </button>
      </div>
    </div>}
    {error && <small className="composer-error" role="alert">{error}</small>}
  </form>
}
