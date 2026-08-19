import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  MAX_INPUT_FILE_BYTES,
  createInputFilePart,
  inputPartLabel,
  withAttachmentAnchors,
} from '../../shared/input-parts.mjs'
import { applyDraftOperation } from '../../shared/dictation-draft.mjs'
import { t } from './i18n.js'
import { dictationControlView } from './dictation-view.js'

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

export function DictationControls({ dictation }) {
  const view = dictationControlView({
    enabled: dictation?.enabled,
    state: dictation?.state,
  })
  if (!view.visible) return null
  const act = () => {
    if (view.action === 'pause') dictation.pause()
    else if (view.action === 'resume') dictation.resume()
    else dictation.start()
  }
  return <div className="dictation-controls">
    <button
      className="composer-dictation"
      type="button"
      aria-label={view.label}
      title={`${view.label} · Ctrl/Cmd+Shift+D`}
      onClick={act}
    >{view.action === 'pause' ? 'Ⅱ' : '◉'}</button>
    <small className={`dictation-state is-${dictation.state}`} role="status">
      {view.label}{dictation.preview ? ` · ${dictation.preview}` : ''}
    </small>
    {(dictation.capturing || dictation.state === 'paused') && <button
      className="dictation-cancel"
      type="button"
      aria-label={t('取消听写')}
      title={t('取消听写（Esc）')}
      onClick={dictation.cancel}
    >×</button>}
  </div>
}

const MultimodalComposer = forwardRef(function MultimodalComposer({
  onSend,
  onStage,
  dictation,
}, ref) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState('')
  const picker = useRef(null)
  const textarea = useRef(null)
  const textValue = useRef('')
  const revision = useRef(0)
  const submittedDictation = useRef(new Map())

  const updateText = useCallback(value => {
    const next = String(value || '')
    textValue.current = next
    revision.current += 1
    setText(next)
  }, [])

  const updateAttachments = useCallback(next => {
    revision.current += 1
    setAttachments(next)
    onStage(next.map(item => item.part))
  }, [onStage])

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

  const submitCurrent = useCallback(() => {
    const content = textValue.current.trim()
    if (!content && !attachments.length) return
    const parts = withAttachmentAnchors([
      ...(content ? [{ type: 'text', text: content }] : []),
      ...attachments.map(item => item.part),
    ])
    if (!onSend(parts)) {
      setError(t('Gateway 尚未连接'))
      return false
    }
    updateText('')
    updateAttachments([])
    setError('')
    return true
  }, [attachments, onSend, updateAttachments, updateText])

  const submit = event => {
    event?.preventDefault()
    return submitCurrent()
  }

  useImperativeHandle(ref, () => ({
    snapshot() {
      const element = textarea.current
      const length = textValue.current.length
      return {
        text: textValue.current,
        selectionStart: element?.selectionStart ?? length,
        selectionEnd: element?.selectionEnd ?? length,
        revision: revision.current,
      }
    },
    applyOperation(operation) {
      const element = textarea.current
      const length = textValue.current.length
      const result = applyDraftOperation({
        text: textValue.current,
        selectionStart: element?.selectionStart ?? length,
        selectionEnd: element?.selectionEnd ?? length,
        revision: revision.current,
      }, operation)
      if (!result.applied) return result
      textValue.current = result.text
      revision.current = result.revision
      setText(result.text)
      requestAnimationFrame(() => {
        textarea.current?.setSelectionRange(
          result.selectionStart,
          result.selectionEnd,
        )
        textarea.current?.focus()
      })
      return result
    },
    commitDictation(commitId) {
      if (submittedDictation.current.has(commitId)) {
        return submittedDictation.current.get(commitId)
      }
      submittedDictation.current.set(commitId, false)
      const submitted = submitCurrent() === true
      submittedDictation.current.set(commitId, submitted)
      return submitted
    },
  }), [submitCurrent])

  return <form
    className="multimodal-composer"
    onSubmit={submit}
    onDragOver={event => event.preventDefault()}
    onDrop={event => {
      event.preventDefault()
      addFiles(event.dataTransfer.files)
    }}
  >
    <DictationControls dictation={dictation} />
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
        ref={textarea}
        value={text}
        rows="1"
        placeholder={t('输入文字，或粘贴、拖入图片和文件')}
        onChange={event => updateText(event.target.value)}
        onPaste={event => {
          const files = event.clipboardData?.files
          if (!files?.length) return
          event.preventDefault()
          addFiles(files, 'clipboard')
        }}
        onKeyDown={event => {
          if (
            dictation?.enabled
            && (event.ctrlKey || event.metaKey)
            && event.shiftKey
            && event.key.toLowerCase() === 'd'
          ) {
            event.preventDefault()
            dictation.toggle()
            return
          }
          if (
            dictation?.enabled
            && event.key === 'Escape'
            && (dictation.capturing || dictation.state === 'paused')
          ) {
            event.preventDefault()
            dictation.cancel()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) submit(event)
        }}
      />
      <button className="composer-send" type="submit">{t('发送')}</button>
    </div>
    {error && <small className="composer-error" role="alert">{error}</small>}
  </form>
})

export default MultimodalComposer
