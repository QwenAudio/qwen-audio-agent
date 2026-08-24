import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_INPUT_FILE_BYTES,
  createInputFilePart,
  inputPartLabel,
  withAttachmentAnchors,
} from '../../shared/input-parts.mjs'
import { t } from './i18n.js'
import { ComposerDictationClient } from './composer-dictation.js'
import { dictationStateLabel } from '../../shared/dictation-contract.mjs'

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
  dictation = {},
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState('')
  const picker = useRef(null)
  const textRef = useRef(text)
  textRef.current = text
  const dictationClient = useRef(null)
  const handledDictationEvent = useRef(0)
  const [dictationView, setDictationView] = useState({
    state: 'idle', partial: '', error: '', notice: '',
  })
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

  const submitContent = useCallback(content => {
    const normalized = String(content || '').trim()
    if (!normalized && !attachments.length) return false
    const parts = withAttachmentAnchors([
      ...(normalized ? [{ type: 'text', text: normalized }] : []),
      ...attachments.map(item => item.part),
    ])
    if (!onSend(parts)) {
      setError(t('Gateway 尚未连接'))
      return false
    }
    setText('')
    updateAttachments([])
    setError('')
    return true
  }, [attachments, onSend, updateAttachments])
  const submitContentRef = useRef(submitContent)
  submitContentRef.current = submitContent

  const submit = event => {
    event.preventDefault()
    const submitted = submitContent(text)
    if (submitted) dictationClient.current?.manualCommitted()
  }

  useEffect(() => {
    if (!dictation.enabled) {
      dictationClient.current = null
      setDictationView({ state: 'idle', partial: '', error: '' })
      return undefined
    }
    const client = new ComposerDictationClient({
      enabled: true,
      canStart: () => dictation.canStart === true,
      send: dictation.send,
      submit: content => submitContentRef.current(content),
      setCapture: dictation.setCapture,
      onView: view => {
        setText(view.text)
        setDictationView(view)
      },
    })
    dictationClient.current = client
    const shortcut = event => client.shortcut(event, textRef.current)
    window.addEventListener('keydown', shortcut)
    return () => {
      window.removeEventListener('keydown', shortcut)
      client.stop('dictation.cancel')
      if (dictationClient.current === client) dictationClient.current = null
    }
  }, [
    dictation.canStart,
    dictation.enabled,
    dictation.send,
    dictation.setCapture,
  ])

  useEffect(() => {
    if (dictation.canStart !== true && dictationClient.current?.active) {
      dictationClient.current.stop('dictation.cancel')
    }
  }, [dictation.canStart])

  useEffect(() => {
    for (const item of dictation.events || []) {
      if (!Number.isInteger(item?.id) || item.id <= handledDictationEvent.current) continue
      handledDictationEvent.current = item.id
      dictationClient.current?.handle(item.event)
    }
  }, [dictation.events])

  return <form
    className="multimodal-composer"
    onSubmit={submit}
    onDragOver={event => event.preventDefault()}
    onDrop={event => {
      event.preventDefault()
      addFiles(event.dataTransfer.files)
    }}
  >
    {dictation.enabled && <div className="composer-dictation" role="status">
      <button
        type="button"
        aria-label={t('切换听写')}
        title={t('听写（Ctrl/⌘+Shift+D）')}
        disabled={!dictationClient.current?.active && dictation.canStart !== true}
        onClick={() => dictationClient.current?.active
          ? dictationClient.current.stop()
          : dictationClient.current?.start(text)}
      >🎙</button>
      <span>
        {t(dictationStateLabel(dictationView.state))}
        {dictationView.notice ? ` · ${dictationView.notice}` : ''}
      </span>
      {dictationView.partial && <span className="composer-dictation-partial">
        {dictationView.partial}
      </span>}
    </div>}
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
        onChange={event => {
          if (dictationClient.current?.active) {
            dictationClient.current.keyboard(event.target.value)
          } else setText(event.target.value)
        }}
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
    {dictationView.error && <small className="composer-error" role="alert">
      {dictationView.error}
    </small>}
  </form>
}
