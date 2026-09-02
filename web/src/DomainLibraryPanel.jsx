import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'

// 资料库面板：把本机的手册 / 规章 / 教材交给助手。
//
// 入口是「一条本机路径」而不是上传文件，有两个原因：
//   · 这是本地服务，文件本来就在盘上，复制一份比经 base64 中转再落盘简单得多；
//   · 浏览器的 <input type="file"> 拿不到完整路径，File 对象只有 name。
//     所以「点按钮选文件」在网页里做不到 —— 那是浏览器的安全限制。
//     Electron 可以用原生对话框拿到真实路径，日后再作为增强补上。
//
// PDF / Word 会先交给后台提取文字，那是一次后台任务，所以这里要轮询它的状态。

const POLL_INTERVAL_MS = 2000

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DomainLibraryPanel({ onClose, getTask }) {
  const [documents, setDocuments] = useState([])
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // 正在后台转换的文件：{ taskId, filename }
  const [converting, setConverting] = useState([])
  // 功能没开时给一句明确的说明，而不是让面板空着让人以为坏了
  const [disabled, setDisabled] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('api/domain', { cache: 'no-store' })
      if (response.status === 404) {
        setDisabled(true)
        return
      }
      if (!response.ok) throw new Error(String(response.status))
      const payload = await response.json()
      setDocuments(Array.isArray(payload.documents) ? payload.documents : [])
      setDisabled(false)
    } catch {
      setError(t('读不到资料列表'))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 轮询后台转换。转换完成时由服务端负责收录，所以这里只要刷新列表即可。
  useEffect(() => {
    if (!converting.length) return undefined
    const timer = setInterval(async () => {
      for (const item of converting) {
        const task = await getTask?.(item.taskId).catch(() => null)
        const status = task?.status
        if (!status || ['queued', 'running', 'delegated', 'finalizing'].includes(status)) {
          continue
        }
        setConverting(items => items.filter(entry => entry.taskId !== item.taskId))
        if (status === 'completed') {
          setNotice(t('“{name}” 已提取并收进资料库', { name: item.filename }))
          refresh()
        } else {
          setError(task?.error || t('“{name}” 提取失败', { name: item.filename }))
        }
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [converting, getTask, refresh])

  const submit = async event => {
    event.preventDefault()
    const trimmed = path.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('api/domain/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      })
      const payload = await response.json().catch(() => ({}))
      if (response.status === 202) {
        // PDF / Word：后台正在提取文字
        setConverting(items => [
          ...items,
          { taskId: payload.task_id, filename: payload.target || trimmed },
        ])
        setNotice(t('正在后台提取文字，完成后会自动收进资料库'))
        setPath('')
        return
      }
      if (!response.ok) {
        setError(payload.message || payload.error || t('导入失败（{status}）', {
          status: response.status,
        }))
        return
      }
      setNotice(t('已收进资料库：{name}', { name: payload.document?.title || trimmed }))
      setPath('')
      refresh()
    } catch {
      setError(t('导入失败，请稍后再试'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async document => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`api/domain/${encodeURIComponent(document.id)}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error(String(response.status))
      setNotice(t('已移除：{name}', { name: document.title }))
      refresh()
    } catch {
      setError(t('移除失败，请稍后再试'))
    } finally {
      setBusy(false)
    }
  }

  return <aside className="domain-panel" aria-label={t('资料库')}>
    <header>
      <b>{t('资料库')}</b>
      {onClose && <button type="button" onClick={onClose} aria-label={t('关闭')}>×</button>}
    </header>

    {disabled
      ? <p className="domain-hint">{t('资料库功能未开启。')}</p>
      : <>
        <form onSubmit={submit}>
          <input
            type="text"
            value={path}
            spellCheck={false}
            placeholder={t('粘贴本机文件路径，例如 /Users/me/手册.md')}
            onChange={event => setPath(event.target.value)}
          />
          <button type="submit" disabled={busy || !path.trim()}>
            {t('加入资料库')}
          </button>
        </form>
        <p className="domain-hint">
          {t('支持 Markdown、txt 等文本；PDF、Word 会先交给后台提取文字。')}
        </p>

        {error && <p className="domain-error" role="alert">{error}</p>}
        {notice && <p className="domain-notice">{notice}</p>}

        {converting.map(item => <div key={item.taskId} className="domain-item pending">
          <b>{item.filename}</b>
          <small>{t('正在提取文字…')}</small>
        </div>)}

        {!documents.length && !converting.length && <p className="domain-hint">
          {t('还没有资料。加进来之后，助手就知道该去查哪一份。')}
        </p>}

        {documents.map(document => <div key={document.id} className="domain-item">
          <b>{document.title}</b>
          {document.gist && <small>{document.gist}</small>}
          {document.sections?.length > 0 && <small className="domain-sections">
            {document.sections.join(' · ')}
          </small>}
          <small className="domain-meta">
            {[
              document.filename,
              formatBytes(document.bytes),
              document.summarised ? '' : t('待摘要'),
            ].filter(Boolean).join(' · ')}
          </small>
          <button type="button" onClick={() => remove(document)} disabled={busy}>
            {t('移除')}
          </button>
        </div>)}
      </>}
  </aside>
}
