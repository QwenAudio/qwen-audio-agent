import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import AvatarHero from './AvatarHero.jsx'
import defaultPreview from './assets/vidu-default-preview.png'
import { avatarVisualState, avatarStatusDot } from './avatar-status.js'
import { useDualConnection } from './useDualConnection.js'
import { installWindowDrag } from './window-drag.mjs'

const DEFAULT_IMAGE = 'https://scene.vidu.zone/media-asset/083014-Qww8rvO5sOtAKZW8.png'

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
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [imageError, setImageError] = useState(null)
  const imageEpoch = useRef(0)
  const dragRef = useRef(null)
  const { config, notice } = useExampleConfig()
  const vidu = config?.renderer?.id === 'vidu'
  const avatar = useDualConnection({ sessionId, config, image: image || DEFAULT_IMAGE, autoMic: vidu })
  const desktop = window.viduAvatarDesktop
  const overlay = Boolean(desktop && vidu)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [conversationOpen, setConversationOpen] = useState(false)
  useEffect(() => {
    if (desktop) installWindowDrag(dragRef.current, desktop)
  }, [desktop])
  const upload = async event => {
    const epoch = ++imageEpoch.current
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      setImageError('请选择不超过 4 MB 的 PNG/JPEG/WebP 图片。'); return
    }
    try {
      const result = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      if (epoch === imageEpoch.current) { setImage(result); setImageError(null) }
    } catch { if (epoch === imageEpoch.current) setImageError('读取图片失败。') }
  }

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
    <main className={`app${vidu ? ' app-vidu' : ''}${desktop ? ' app-desktop' : ''}${overlay ? ' app-overlay' : ''}${settingsOpen ? ' settings-open' : ''}${conversationOpen ? ' conversation-open' : ''}`}>
      {desktop && <div className="desktop-toolbar">
        <div ref={dragRef} className="desktop-drag">数字人浮窗 · 拖动</div>
        {overlay && <>
          <button aria-expanded={conversationOpen} onClick={() => setConversationOpen(value => !value)}>对话</button>
          <button aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>设置</button>
        </>}
        {desktop.setAlwaysOnTop && <button aria-pressed={alwaysOnTop} onClick={async () => {
          try { setAlwaysOnTop(await desktop.setAlwaysOnTop(!alwaysOnTop)) } catch { /* Window is closing. */ }
        }}>{alwaysOnTop ? '取消置顶' : '置顶'}</button>}
        <button onClick={() => { avatar.disconnect(); desktop.quit() }}>关闭</button>
        {desktop.canSwitchToOrb && <button onClick={() => { avatar.disconnect('switch_to_orb'); desktop.switchToOrb() }}>切换悬浮球</button>}
      </div>}
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
          disabled={!config || config.renderer?.enabled === false || avatar.state === 'connecting' || (avatar.state === 'connected' && avatar.rendererAvailable)}
          data-testid="avatar-connect"
        >
          {avatar.state === 'connected' ? (avatar.rendererAvailable ? '已连接' : '重新连接') : avatar.state === 'connecting' ? '连接中…' : '连接数字人'}
        </button>
        <button className="ghost" onClick={avatar.interrupt} disabled={avatar.state !== 'connected'}>打断</button>
        <button className="ghost" onClick={() => avatar.disconnect()} disabled={avatar.state === 'idle'}>结束</button>
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
        <AvatarHero avatar={avatar} personaId={config?.persona || '—'} rendererId={config?.renderer?.id} referenceImage={!image || image === DEFAULT_IMAGE ? defaultPreview : image} />
        {notice && <p className="notice" role="status">{notice}</p>}
        {vidu && <aside className="renderer-settings">
          <p role="status">Vidu 延迟展示预览。打断按原始音频时间线处理，已上传的数字人内容会继续展示，不硬切。
            连接即启动持续直播，待机也可能产生 Vidu/ARTC 费用；结束后挂断。</p>
          <label><input type="checkbox" checked={avatar.sourceAudible} disabled={avatar.state !== 'connected'}
            onChange={avatar.toggleSourceAudio} />原声对照（隐藏数字人并播放原始音频）</label>
          {config.renderer?.enabled === false && <p>{config.renderer.reason}</p>}
          <label>角色图片 HTTPS URL<input disabled={avatar.state !== 'idle' && avatar.state !== 'error'} value={image.startsWith('data:') ? '' : image}
            onChange={event => { imageEpoch.current++; setImage(event.target.value); setImageError(null) }} placeholder={DEFAULT_IMAGE} /></label>
          <label>或上传（最多 4 MB，连接前选择）<input disabled={avatar.state !== 'idle' && avatar.state !== 'error'} type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label>
          {image.startsWith('data:') && <small>已选择上传图片</small>}
          {imageError && <p role="alert">{imageError}</p>}
        </aside>}

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
