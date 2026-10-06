import { useCallback, useRef, useState } from 'react'
import {
  MAX_INPUT_FILE_BYTES,
  createInputFilePart,
  inputPartLabel,
  withAttachmentAnchors,
} from '../../../shared/input-parts.mjs'
import { t } from '../i18n.js'
import PhotoCapture from './PhotoCapture.jsx'
import { blobToBase64 } from './camera-input.js'

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
  const [photoOpen, setPhotoOpen] = useState(false)
  const picker = useRef(null)
  const updateAttachments = useCallback(next => {
    setAttachments(next)
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
    } catch (reason) {
      setError(reason?.message || String(reason))
    }
  }, [attachments, updateAttachments])

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
    {photoOpen && <PhotoCapture
      onClose={() => setPhotoOpen(false)}
      onCapture={async (blob, isCurrent) => {
        const image = await blobToBase64(blob)
        if (!isCurrent()) return false
        const id = crypto.randomUUID()
        const filename = `photo-${Date.now()}.jpg`
        setAttachments(current => isCurrent() ? [...current, {
          id, part: createInputFilePart({ mime: 'image/jpeg', filename,
            url: `data:image/jpeg;base64,${image}` }, current.length),
        }] : current)
        setError('')
        return true
      }}
    />}
    <div className="composer-row">
      <button
        className="composer-attach"
        type="button"
        title={t('添加图片或文件')}
        aria-label={t('添加图片或文件')}
        onClick={() => picker.current?.click()}
      >＋</button>
      <button className="composer-photo" type="button" title={t('拍照')} aria-label={t('拍照')}
        onClick={() => setPhotoOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l2-3h4l2 3h4v15H4V6z" /><circle cx="12" cy="13" r="4" /></svg>
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
    {error && <small className="composer-error" role="alert">{error}</small>}
  </form>
}
