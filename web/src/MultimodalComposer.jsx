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
  compact = false,
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const picker = useRef(null)
  const cameraVideo = useRef(null)
  const cameraStream = useRef(null)
  const updateAttachments = useCallback(next => {
    setAttachments(next)
  }, [])

  const closeCamera = useCallback(() => {
    stopCameraStream(cameraStream.current)
    cameraStream.current = null
    if (cameraVideo.current) {
      cameraVideo.current.pause?.()
      cameraVideo.current.srcObject = null
    }
    setCameraReady(false)
    setCameraOpen(false)
  }, [])

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
    const onVisibilityChange = () => {
      if (document.hidden) closeCamera()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [closeCamera])

  useEffect(() => () => stopCameraStream(cameraStream.current), [])

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
      if (await addFiles([file], 'camera')) closeCamera()
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
      <div className="camera-actions">
        <button type="button" className="ghost" onClick={closeCamera}>{t('取消')}</button>
        <button type="button" className="composer-send" disabled={!cameraReady} onClick={() => void capturePhoto()}>
          {t('拍摄')}
        </button>
      </div>
    </div>}
    {error && <small className="composer-error" role="alert">{error}</small>}
  </form>
}
