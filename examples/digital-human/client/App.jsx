import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import AvatarHero from './AvatarHero.jsx'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import { useWebRtcVoice } from './useWebRtcVoice.js'
import { gatewayFetch } from './gateway-fetch.js'

// Standalone shell for bounded avatar mode. The product SPA (web/) owns tasks,
// permissions, the knowledge library and the multimodal composer; none of that
// exists here. This page is one WebRTC voice session, one avatar downlink and
// one transcript panel.

const SESSION_KEY = 'qwen-audio-agent.digital-human.session'
// Mirrors the Gateway's own sessionId validation (webrtc/routes.mjs), so a
// hand-written ?session= is rejected here instead of 400ing on the offer.
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
  if (current) return current
  const created = crypto.randomUUID()
  localStorage.setItem(SESSION_KEY, created)
  return created
}

// Resolves which persona to drive from the Gateway's allowlist. The server stays
// the only authority: it re-validates the id on the offer, and this hook never
// invents one. Reading the allowlist also lets a Gateway started without
// --renderer explain itself instead of looking like a hung connection.
function usePersona() {
  const [resolved, setResolved] = useState({ personaId: null, notice: null })

  useEffect(() => {
    let cancelled = false
    const publish = value => { if (!cancelled) setResolved(value) }
    const requested = queryParam('persona')
    void (async () => {
      try {
        const response = await gatewayFetch('/api/v1/webrtc/config')
        const config = await response.json()
        if (!response.ok) throw new Error(config.error?.message || `HTTP ${response.status}`)
        const personas = config.digital_human?.personas || []
        if (!config.digital_human?.available || !personas.length) {
          publish({
            personaId: null,
            notice: 'Gateway 未启用数字人：启动时需要 --renderer=<url>，且 persona 白名单不能为空。',
          })
          return
        }
        if (requested && personas.includes(requested)) {
          publish({ personaId: requested, notice: null })
          return
        }
        publish({
          personaId: personas[0],
          notice: requested
            ? `persona「${requested}」不在服务端白名单，已改用「${personas[0]}」。`
            : null,
        })
      } catch (error) {
        publish({ personaId: null, notice: error?.message || String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  return resolved
}

export default function App() {
  const [sessionId, setSessionId] = useState(getSessionId)
  const { personaId, notice } = usePersona()
  // Inert until the persona resolves: the hook only connects when it has one.
  const avatar = useWebRtcVoice({ sessionId, avatarPersonaId: personaId })

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

  // Switching the session id reconnects the WebRTC session, and useWebRtcVoice
  // drops its cached transcript on that change.
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
          className={`voice${avatar.micEnabled ? ' active' : ''}`}
          aria-label={avatar.micEnabled ? '麦克风静音' : '开启麦克风'}
          onClick={avatar.toggleMic}
          data-testid="avatar-mic"
        >
          {avatar.micEnabled ? '麦克风静音' : '开启麦克风'}
        </button>
      </header>

      <section className="workspace">
        <AvatarHero avatar={avatar} personaId={personaId || '—'} />
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
