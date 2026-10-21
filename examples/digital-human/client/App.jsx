import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import AvatarHero from './AvatarHero.jsx'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import { useDualConnection } from './useDualConnection.js'

// Standalone shell for bounded avatar mode. The product SPA (web/) owns tasks,
// permissions, the knowledge library and the multimodal composer; none of that
// exists here. Gateway conversation and the replaceable avatar renderer have
// separate connections; this example owns their presentation and transcript.

const SESSION_KEY = 'qwen-audio-agent.digital-human.session'
// Reject invalid hand-written session IDs before opening the ordinary Gateway.
const SESSION_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

const STATUS_LABELS = {
  connecting: '正在连接',
  idle: '待命',
  listening: '正在听',
  processing: '正在处理',
  speaking: '正在说话',
  audio_only: '仅音频（头像降级）',
  error: '连接异常',
}

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

function getSessionId() {
  const requested = queryParam('session')
  if (requested && SESSION_PATTERN.test(requested)) {
    localStorage.setItem(SESSION_KEY, requested)
    return requested
  }
  const current = localStorage.getItem(SESSION_KEY)
  if (current && SESSION_PATTERN.test(current)) return current
  const created = crypto.randomUUID()
  localStorage.setItem(SESSION_KEY, created)
  return created
}

// The example bridge owns renderer configuration and credentials. None of
// these fields are a special mode or provider setting on the Gateway.
function useExampleConfig() {
  const [resolved, setResolved] = useState({ config: null, notice: null })

  useEffect(() => {
    let cancelled = false
    const publish = value => { if (!cancelled) setResolved(value) }
    void (async () => {
      try {
        const response = await fetch('/api/config')
        const config = await response.json()
        if (!response.ok) throw new Error(config.error?.message || `HTTP ${response.status}`)
        if (!config.gatewayPath || !config.rendererPath || !config.persona) throw new Error('示例服务配置不完整。')
        publish({ config, notice: null })
      } catch (error) {
        publish({ config: null, notice: error?.message || String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  return resolved
}

export default function App() {
  const [sessionId, setSessionId] = useState(getSessionId)
  const { config, notice } = useExampleConfig()
  const avatar = useDualConnection({ sessionId, config })

  const messagesRef = useRef(null)
  const stickToBottom = useRef(true)

  // The whole transport object is passed on purpose: avatarVisualState also
  // reads micEnabled to tell 正在听 from 待命 while connected.
  const visual = avatarVisualState(avatar)
  const dot = avatarStatusDot(visual)

  useLayoutEffect(() => {
    const container = messagesRef.current
    if (container && stickToBottom.current) container.scrollTop = container.scrollHeight
  }, [avatar.messages])

  // A new session closes both old connections and all queued media. A fresh
  // explicit connection gesture keeps browser audio activation unambiguous.
  const resetSession = () => {
    const next = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, next)
    stickToBottom.current = true
    setSessionId(next)
  }

  const renderMessage = message => (
    <article key={message.id} className={message.role}>
      <label>{message.role === 'user' ? '你' : 'qwen-audio'}</label>
      <div className="message-body">{message.content}</div>
      {message.interrupted && <small className="interrupted">已打断</small>}
    </article>
  )

  return (
    <main className="app">
      <header>
        <div className="brand">
          <span>V</span>
          <div>qwen-audio-agent<small>DIGITAL HUMAN · REALTIME</small></div>
        </div>
        <div className="status">
          <i className={dot} />
          <span>{STATUS_LABELS[visual] || STATUS_LABELS.idle}</span>
        </div>
        <button className="ghost" onClick={resetSession}>新会话</button>
        <button
          className="ghost"
          onClick={avatar.start}
          disabled={!config || avatar.state === 'connecting' || (avatar.state === 'connected' && avatar.rendererAvailable)}
          data-testid="avatar-connect"
        >
          {avatar.state === 'connected' ? (avatar.rendererAvailable ? '已连接' : '重新连接') : avatar.state === 'connecting' ? '连接中…' : '连接数字人'}
        </button>
        <button
          className={`voice${avatar.micEnabled ? ' active' : ''}`}
          aria-label={avatar.micEnabled ? '麦克风静音' : '开启麦克风'}
          onClick={avatar.toggleMic}
          disabled={avatar.state !== 'connected'}
          data-testid="avatar-mic"
        >
          {avatar.micEnabled ? '麦克风静音' : '开启麦克风'}
        </button>
      </header>

      <section className="workspace">
        <AvatarHero avatar={avatar} personaId={config?.persona || '—'} />
        {notice && <p className="notice" role="status">{notice}</p>}

        <div
          className="messages"
          ref={messagesRef}
          aria-live="polite"
          onScroll={event => {
            const container = event.currentTarget
            stickToBottom.current = (
              container.scrollHeight - container.scrollTop - container.clientHeight
              < 48
            )
          }}
        >
          {avatar.messages.length
            ? avatar.messages.map(renderMessage)
            : <div className="empty">
              <b>试着说</b>
              <span>说话或输入文字开始</span>
            </div>}
        </div>
      </section>
    </main>
  )
}
