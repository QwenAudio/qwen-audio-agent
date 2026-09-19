import { useCallback, useEffect, useRef, useState } from 'react'
import useRealtimeVoice from '../../../web/src/realtime/useRealtimeVoice.js'
import useWebRtcVoice from './useWebRtcVoice.js'
import { VisualCapture } from './capture.js'
import { visualFeatures } from '../vision/features.mjs'
import { gatewayFetch } from '../../../web/src/gateway-transport.js'

const CAPABILITY = 'client.actions.xomni.visual.capture'
const ACTION = 'xomni.visual.capture'
const SESSION = `xomni-${crypto.randomUUID()}`
const TRANSPORT = import.meta.env.VITE_X_OMNI_TRANSPORT || 'websocket'
const useVoice = TRANSPORT === 'webrtc' ? useWebRtcVoice : useRealtimeVoice

export default function App() {
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState('on-demand')
  const [visual, setVisual] = useState({ source: 'none', active: false, generation: '' })
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const [captureBusy, setCaptureBusy] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const [features, setFeatures] = useState(null)
  const videoRef = useRef(null)
  const captureRef = useRef(null)
  const handleEvent = useCallback(event => {
    if (event.type !== 'transcript.final' && event.type !== 'transcript.delta') return
    if (!event.content) return
    const key = `${event.role}:${event.itemId || event.responseId || event.turnId || 'current'}`
    setMessages(old => {
      const next = old.filter(item => item.key !== key)
      // Gateway transcripts are cumulative snapshots, including ASR revisions.
      return [...next, { key, role: event.role, text: event.content }].slice(-80)
    })
  }, [])
  const capture = useCallback(async () => {
    setCaptureBusy(true)
    try {
      const frame = await captureRef.current.capture()
      setPreview(`data:image/jpeg;base64,${frame.image}`)
      return frame
    } finally { setCaptureBusy(false) }
  }, [])
  const handleAction = useCallback(async event => {
    if (event.name !== ACTION) return { status: 'unsupported', error: { code: 'unknown_action', message: 'Unsupported client action' } }
    try { return { status: 'completed', output: await capture() } }
    catch (reason) { return { status: 'failed', error: { code: 'capture_failed', message: reason.message } } }
  }, [capture])
  const voice = useVoice({ sessionId: SESSION, enabled, inputOnlyMute: true,
    clientLabel: 'X-Omni', additionalCapabilities: [CAPABILITY], onEvent: handleEvent, onClientAction: handleAction })
  const { imageBufferAvailable, sendImageFrame, clearImageBuffer } = voice
  const publishRef = useRef(voice.publishClientEvent)
  publishRef.current = voice.publishClientEvent
  useEffect(() => {
    const controller = new AbortController()
    gatewayFetch('/api/health', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法读取 Gateway 能力')
      const health = await response.json()
      if (controller.signal.aborted) return
      const next = visualFeatures({ provider: health.realtimeProvider, modelProfile: health.realtimeModelProfile })
      setFeatures(next)
      if (!next.visualTools) setMode('continuous')
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const controller = new VisualCapture(videoRef.current, state => {
      setVisual(state)
      setPreview('')
    })
    captureRef.current = controller
    return () => controller.stop()
  }, [])
  useEffect(() => {
    if (voice.connectionState !== 'connected' || !features?.visualTools) return
    publishRef.current('xomni.visual.state', { ...visual, mode })
  }, [visual, mode, voice.connectionState, features])
  useEffect(() => {
    if (mode !== 'continuous' || !visual.active || !enabled || !imageBufferAvailable) return
    let pending = false
    let disposed = false
    const timer = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        const frame = await captureRef.current.capture()
        if (!disposed && sendImageFrame(frame.image, frame.capturedAt)) setFrameCount(count => count + 1)
      } catch (reason) { if (!disposed) setError(reason.message) }
      finally { pending = false }
    }, 1000)
    return () => { disposed = true; clearInterval(timer); clearImageBuffer() }
  }, [mode, visual, enabled, imageBufferAvailable, sendImageFrame, clearImageBuffer])
  const select = async source => {
    try { setError(''); await captureRef.current.open(source) }
    catch (reason) { setError(reason.message) }
  }
  const send = async text => {
    if (!text.trim() || !features?.textInput) return
    try { await voice.activateAudio(); setError('') }
    catch (reason) { setError(reason.message); return }
    if (!voice.sendInput([{ type: 'text', text: text.trim() }])) { setError('Gateway 尚未连接'); return }
    setDraft('')
  }
  return <main>
    <header><span className="eyebrow">QWEN AUDIO AGENT · EXAMPLE</span><h1>X-Omni</h1>
      <p>看见，交流，持续关注。实时多模态助手参考示例。</p>
      <div className="status"><span className={`dot ${voice.connectionState === 'connected' ? 'online' : ''}`} />
        {voice.connectionState} · {voice.state} · {TRANSPORT === 'webrtc' ? 'WebRTC' : 'WebSocket'}
        {TRANSPORT === 'webrtc' && voice.connectionState === 'disconnected' && <button onClick={voice.reconnect}>重新连接</button>}
        <button onClick={async () => {
          try { await voice.activateAudio(); setEnabled(value => !value) }
          catch (reason) { setError(reason.message) }
        }}>
          {enabled ? '静音麦克风' : '开启麦克风'}</button>
      </div>
    </header>
    <section className="workspace">
      <article className="vision panel">
        <div className="section-heading"><h2>视觉来源</h2><span>{captureBusy ? '正在采集' : visual.source}</span></div>
        <div className="toolbar">
          <button onClick={() => select('camera')}>摄像头</button>
          <button onClick={() => select('screen')}>共享屏幕</button>
          <label className="button">打开图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async event => {
            try { await captureRef.current.openFile(event.target.files[0]); await capture() }
            catch (reason) { setError(reason.message) }
          }} /></label>
          <button onClick={() => captureRef.current.stop()}>关闭来源</button>
        </div>
        <div className="preview">
          <video ref={videoRef} muted playsInline hidden={visual.source === 'image' || !visual.active} />
          {visual.source === 'image' && preview && <img src={preview} alt="用户选择的图片" />}
          {!visual.active && <p>先选择来源并授权。尚未采集或发送任何画面。</p>}
        </div>
        <div className="modes" role="group" aria-label="采集模式">
          <button disabled={!features?.visualTools} className={mode === 'on-demand' ? 'selected' : ''} onClick={() => setMode('on-demand')}>按需采集</button>
          <button disabled={!features?.continuous} className={mode === 'continuous' ? 'selected' : ''} onClick={() => setMode('continuous')}>持续画面</button>
        </div>
        <p className="hint">{mode === 'on-demand'
          ? '平时仅本地预览。询问画面时，短时 Omni 视觉会话读取一帧，并把观察结果交回主对话。'
          : `麦克风开启时，每秒向主 Omni 会话发送一帧。已发送 ${frameCount} 帧。`}</p>
        {!features?.visualTools && features && <p className="hint">当前接口仅支持持续画面与语音对话，未开放按需识图和观察工具。</p>}
        {features?.visualTools && <details><summary>观察与解说</summary>
          <p>明确提出观察条件或要求持续解说后才启动。每 10 秒采样，默认 2 分钟，最多 10 分钟、2 个观察；会产生额外模型费用。</p>
          <button onClick={() => send('请列出当前视觉观察状态。')}>查看观察状态</button>
          <button onClick={() => send('停止所有视觉观察和解说。')}>停止所有观察</button>
          <p>关闭或切换来源、断开页面会停止观察。这不是录像、音频监听或安全告警系统。</p>
        </details>}
      </article>
      <article className="conversation panel"><h2>对话</h2>
        <div className="messages" role="log" aria-live="polite">
          {!messages.length && <div className="empty"><p>可以试着说：</p><p>“看看当前画面里有什么。”</p>{features?.visualTools && <><p>“这个进度条完成时提醒我，观察两分钟。”</p><p>“接下来一分钟，讲解画面中有意义的变化。”</p></>}</div>}
          {messages.map(message => <div key={message.key} className={`message ${message.role}`}>
            <small>{message.role === 'user' ? '你' : 'X-Omni'}</small><p>{message.text}</p></div>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); send(draft) }}>
          <input aria-label="消息" disabled={!features?.textInput} placeholder={features?.textInput ? '输入问题，或开启麦克风交流…' : '当前接口请使用麦克风交流'} value={draft} onChange={event => setDraft(event.target.value)} />
          <button type="submit" disabled={!features?.textInput}>发送</button>
        </form>
      </article>
    </section>
    {(error || voice.error) && <div role="alert" className="error">{error || voice.error}</div>}
    <footer>只采集明确选择的来源 · 示例不保存截图 · 后台 Agent 可选 · 基于 Gateway Client Protocol</footer>
  </main>
}
