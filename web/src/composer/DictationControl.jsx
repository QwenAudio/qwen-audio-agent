import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n.js'
import {
  isDictationShortcut,
  speechRecognitionConstructor,
} from './dictation.js'

function recognitionErrorText(error) {
  return {
    'not-allowed': t('浏览器没有听写权限'),
    'service-not-allowed': t('浏览器没有听写权限'),
    network: t('浏览器听写服务不可用'),
  }[String(error?.error || '')] || t('听写失败，请稍后重试')
}

export default function DictationControl({
  disabled = false,
  onFinalText,
}) {
  const [active, setActive] = useState(false)
  const [continuous, setContinuous] = useState(true)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const recognitionRef = useRef(null)
  const restartTimerRef = useRef(null)
  const activeRef = useRef(false)
  const continuousRef = useRef(continuous)
  const onFinalTextRef = useRef(onFinalText)
  continuousRef.current = continuous
  onFinalTextRef.current = onFinalText

  const stop = useCallback(() => {
    activeRef.current = false
    clearTimeout(restartTimerRef.current)
    restartTimerRef.current = null
    const recognition = recognitionRef.current
    recognitionRef.current = null
    try {
      recognition?.stop()
    } catch {
      // The browser may already have ended the recognition session.
    }
    setActive(false)
    setInterim('')
  }, [])

  const start = useCallback(() => {
    if (disabled) {
      setError(t('请先关闭实时语音再使用听写'))
      return
    }
    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      setError(t('当前浏览器不支持听写'))
      return
    }

    clearTimeout(restartTimerRef.current)
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = navigator.language || 'zh-CN'
    activeRef.current = true
    recognitionRef.current = recognition
    setError('')
    setNotice('')
    setActive(true)
    recognition.onstart = () => {
      if (activeRef.current) setActive(true)
    }
    recognition.onresult = event => {
      let pending = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript || ''
        if (!result.isFinal) {
          pending += text
          continue
        }
        const outcome = onFinalTextRef.current?.(text)
        if (
          outcome?.action === 'send'
          && outcome.submitted
          && !continuousRef.current
        ) {
          stop()
        }
        if (outcome?.notice) setNotice(outcome.notice)
      }
      setInterim(pending.trim())
    }
    recognition.onerror = event => {
      if (event.error === 'aborted') return
      if (event.error !== 'no-speech') setError(recognitionErrorText(event))
      if (['not-allowed', 'service-not-allowed'].includes(event.error)) stop()
    }
    recognition.onend = () => {
      if (!activeRef.current) {
        setActive(false)
        return
      }
      restartTimerRef.current = setTimeout(() => {
        if (!activeRef.current || recognitionRef.current !== recognition) return
        try {
          recognition.start()
        } catch {
          // A browser can report `end` while its native session is still
          // unwinding. The next result or end event will settle the state.
        }
      }, 0)
    }
    try {
      recognition.start()
    } catch (reason) {
      activeRef.current = false
      recognitionRef.current = null
      setActive(false)
      setError(reason?.message || t('听写失败，请稍后重试'))
    }
  }, [disabled, stop])

  useEffect(() => {
    if (disabled && activeRef.current) stop()
  }, [disabled, stop])

  useEffect(() => {
    const handleKeyDown = event => {
      if (!isDictationShortcut(event)) return
      event.preventDefault()
      if (activeRef.current) stop()
      else start()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [start, stop])

  useEffect(() => () => {
    activeRef.current = false
    clearTimeout(restartTimerRef.current)
    try {
      recognitionRef.current?.stop()
    } catch {
      // Ignore shutdown races from the browser recognition implementation.
    }
    recognitionRef.current = null
  }, [])

  const status = active
    ? interim ? `${t('正在听写')} · ${interim}` : t('正在听写')
    : notice || (error ? '' : t('听写未开启'))

  return <div className="dictation-control">
    <div className="dictation-actions">
      <button
        className={`dictation-toggle${active ? ' active' : ''}`}
        type="button"
        onClick={() => (active ? stop() : start())}
        disabled={disabled && !active}
        title={disabled ? t('请先关闭实时语音再使用听写') : t('听写快捷键')}
        aria-pressed={active}
      >
        {active ? t('停止听写') : t('开始听写')}
      </button>
      <button
        className={`dictation-continuous${continuous ? ' active' : ''}`}
        type="button"
        onClick={() => setContinuous(value => !value)}
        aria-pressed={continuous}
        title={t('发送后继续听写')}
      >
        {continuous ? t('连续听写') : t('单次听写')}
      </button>
      <small>{t('听写快捷键')}: Ctrl/⌘+Shift+Space</small>
    </div>
    <div className={`dictation-status${active ? ' active' : ''}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <span>{status}</span>
    </div>
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </div>
}
