import { useEffect, useRef, useState } from 'react'
import { CAMERA_IMAGE_TOO_LARGE, captureCameraFrame, stopCameraStream } from './camera-input.js'
import { t } from '../i18n.js'

export default function PhotoCapture({ onCapture, onClose }) {
  const dialogRef = useRef(null)
  const videoRef = useRef(null)
  const active = useRef(false)
  const photoUrl = useRef('')
  const [stream, setStream] = useState(null)
  const [ready, setReady] = useState(false)
  const [photo, setPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    active.current = true
    const dialog = dialogRef.current
    dialog.showModal()
    return () => {
      active.current = false
      dialog.close()
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let acquired = null
    const ended = () => {
      if (disposed) return
      setReady(false)
      setError(t('相机连接已断开'))
    }
    const acquire = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('当前浏览器无法使用相机'))
        acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 },
        } })
        if (disposed) { stopCameraStream(acquired); return }
        acquired.getTracks().forEach(track => track.addEventListener('ended', ended))
        setStream(acquired)
      } catch {
        if (!disposed) setError(t('无法打开相机'))
      }
    }
    void acquire()
    return () => {
      disposed = true
      acquired?.getTracks().forEach(track => track.removeEventListener('ended', ended))
      stopCameraStream(acquired)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!stream || !video) return undefined
    video.srcObject = stream
    void video.play().catch(() => {})
    return () => { video.srcObject = null }
  }, [stream, photo])

  const takePhoto = async () => {
    if (!ready || busy || !videoRef.current) return
    setBusy(true)
    try {
      const blob = await captureCameraFrame(videoRef.current)
      if (!active.current) return
      photoUrl.current = URL.createObjectURL(blob)
      setPhoto({ blob, url: photoUrl.current })
      setError('')
    } catch (reason) {
      if (active.current) setError(t(reason?.message === CAMERA_IMAGE_TOO_LARGE ? '视觉帧超过大小限制' : '无法采集视觉画面'))
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const retake = () => {
    URL.revokeObjectURL(photoUrl.current)
    photoUrl.current = ''
    setPhoto(null)
    setReady(false)
    setError('')
  }
  const accept = async () => {
    if (!photo || busy) return
    setBusy(true)
    try {
      const accepted = await onCapture(photo.blob, () => active.current)
      if (active.current && accepted !== false) onClose()
    } catch {
      if (active.current) setError(t('无法读取文件'))
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return <dialog className="photo-capture" ref={dialogRef} aria-label={t('拍照')}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <h2>{t('拍照')}</h2>
    {photo
      ? <img src={photo.url} alt={t('照片预览')} />
      : <video ref={videoRef} autoPlay playsInline muted aria-label={t('相机预览')}
          onLoadedMetadata={() => setReady(true)} />}
    <div className="photo-capture-actions">
      <button type="button" onClick={onClose}>{t('取消')}</button>
      {photo ? <>
        <button type="button" disabled={busy} onClick={retake}>{t('重拍')}</button>
        <button type="button" disabled={busy} onClick={accept}>{t('加入草稿')}</button>
      </> : <button type="button" disabled={!ready || busy} onClick={takePhoto}>{t('拍摄照片')}</button>}
    </div>
    {error && <p className="composer-error" role="alert">{error}</p>}
  </dialog>
}
