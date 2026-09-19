// Browser-only WebRTC client. The model is selected when starting the Gateway.
import { BrowserWebRtcConnection } from './webrtc-browser.mjs'
const $ = id => document.getElementById(id)
let active = null
let closing = null
let connecting = false
let configuration = null
let muted = false
let messages = []
const lines = []
const historyKey = 'qwen-audio-agent.webrtc.session'
try { $('session').value = localStorage.getItem(historyKey) || 'webrtc-demo' } catch {}

function log(event) {
  const text = typeof event === 'string' ? event : JSON.stringify(event)
  lines.push(`${new Date().toLocaleTimeString()} ${text.slice(0, 4000)}`)
  if (lines.length > 80) lines.shift()
  $('log').textContent = lines.join('\n')
  $('log').scrollTop = $('log').scrollHeight
}
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text }
function state(name, text) { $('app').dataset.state = name; $('status').textContent = text }
function headers() { const token = $('token').value.trim(); return token ? { Authorization: `Bearer ${token}` } : {} }
function controls() {
  const busy = connecting || Boolean(closing)
  const ready = active?.ready === true
  $('connect').disabled = Boolean(active) || busy
  $('disconnect').disabled = !active || Boolean(closing)
  $('send').disabled = !ready || busy
  $('interrupt').disabled = !ready || busy
  $('mute').disabled = !ready || busy
  $('camera').disabled = !configuration?.video_input || busy
  $('new-session').disabled = busy
  $('session').disabled = Boolean(active) || busy
  $('token').disabled = Boolean(active) || busy
  $('takeover').disabled = Boolean(active) || busy
}
function send(event) {
  return active?.send(event) || false
}
function receipt(type, responseId) { send({ type: `qwaudio.playback.${type}`, response_id: responseId }) }
function listening() { if (active?.ready) state('listening', muted ? '麦克风已静音' : '可以说话了') }
function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part.text || part.transcript || '').join('\n')
  return ''
}
function renderMessages() {
  const container = $('messages')
  const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 64
  const fragment = document.createDocumentFragment()
  for (const message of messages) {
    const article = document.createElement('article')
    article.className = `message ${message.role}${message.live ? ' live' : ''}`
    const title = document.createElement('header')
    title.textContent = message.role === 'user' ? '你' : 'qwen-audio'
    const content = document.createElement('div')
    content.className = 'content'
    content.textContent = message.content
    article.append(title, content)
    if (message.interrupted) { const hint = document.createElement('small'); hint.textContent = '已打断'; article.append(hint) }
    fragment.append(article)
  }
  $('message-list').replaceChildren(fragment)
  $('empty').hidden = messages.length > 0
  if (atBottom) container.scrollTop = container.scrollHeight
}
function transcript(event) {
  const role = event.type.startsWith('conversation.item.') ? 'user' : 'assistant'
  const final = event.type.endsWith('.completed') || event.type.endsWith('.done')
  const text = final ? event.transcript : event.delta
  if (typeof text !== 'string') return
  const id = `${role}:${event.response_id || event.item_id || 'current'}`
  let message = messages.find(item => item.id === id)
  if (!message && role === 'user') message = messages.find(item => item.pending && item.content === text)
  if (!message) { message = { id, role, content: '', live: true }; messages.push(message) }
  message.id = id
  message.pending = false
  message.content = final || text.startsWith(message.content) ? text : message.content + text
  message.live = !final
  messages = messages.slice(-200)
  renderMessages()
}

async function loadConfiguration() {
  const response = await fetch('/api/v1/webrtc/config', { headers: headers(), signal: AbortSignal.timeout(5000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '无法读取网关配置，请检查访问凭证')
  configuration = result
  $('model').textContent = result.model
  $('model-label').textContent = result.video_input ? 'Qwen Omni' : 'Qwen Audio'
  $('model-capabilities').textContent = result.video_input ? 'Text · Audio · Video' : 'Text · Audio'
  $('model-note').textContent = result.video_input
    ? 'Omni 模式 · 可开启摄像头提问。模型由启动命令指定，页面不修改网关配置。'
    : 'Audio 模式 · 语音与文字对话。体验摄像头请以 example:webrtc:omni 重启网关。'
  $('vision-prompt').hidden = !result.video_input
  if (!result.video_input) $('camera').checked = false
  controls()
  return result
}

async function disconnect() {
  if (closing) return closing
  const current = active
  active = null
  if (!current) return
  closing = (async () => {
    clearInterval(current.meter)
    for (const track of current.camera?.getTracks() || []) track.stop()
    await current.close()
    $('preview').srcObject = null
    $('camera-panel').hidden = true
    $('ack').disabled = true
    $('elapsed').textContent = '00:00'
    $('app').style.setProperty('--level', 0)
    for (const message of messages) message.live = false
    renderMessages()
    state('idle', '已断开')
  })()
  controls()
  try { await closing } finally { closing = null; controls() }
}

function received(current, event) {
  if (active !== current) return
  log(event)
  if (event.type === 'session.updated') {
    listening()
    controls()
    if (!current.historyRequested) {
      current.historyRequested = true
      send({ type: 'qwaudio.command', event: { type: 'conversation.history', event_id: crypto.randomUUID(), session_id: current.sessionId } })
    }
  }
  if (event.type.includes('audio_transcription.') || event.type.startsWith('response.audio_transcript.')) transcript(event)
  if (event.type === 'response.created') state('processing', '正在思考')
  if (event.type === 'qwaudio.output.started') {
    $('ack').disabled = false
  }
  if (event.type === 'output_audio_buffer.cleared') {
    for (const message of messages) if (message.live && message.role === 'assistant') { message.live = false; message.interrupted = true }
    renderMessages()
    listening()
  }
  if (event.type === 'response.done' && event.response?.status === 'failed') notice('本次模型回复失败，请查看连接详情或重试。')
  if (event.type === 'error') notice(event.error?.message || '网关返回错误，请查看连接详情')
  if (event.type === 'qwaudio.event') {
    const item = event.event
    if (item.type === 'conversation.history.result') {
      const history = (item.messages || []).filter(message => ['user', 'assistant'].includes(message.role)).slice(-40)
        .map((message, index) => ({ id: `history:${message.id || index}`, role: message.role, content: messageText(message.content) }))
      const pending = messages.filter(message => message.pending)
      messages = [...history, ...pending.filter(message => !history.some(saved => saved.role === message.role && saved.content === message.content))]
      renderMessages()
    }
    if (item.type === 'voice.connection' && item.state === 'unavailable') notice(item.message || '语音服务暂不可用')
    if (item.type === 'voice.ownership' && item.state === 'busy') notice('当前账号的语音正在被其他客户端使用，可在连接设置中选择接管。')
    if (item.type === 'transcript.discard') {
      const id = item.itemId || item.turnId
      messages = messages.filter(message => !id || message.id !== `user:${id}`)
      renderMessages()
    }
  }
  if (event.type === 'qwaudio.connection.closed') void disconnect()
}

function analyser(context, stream) {
  const source = context.createMediaStreamSource(stream)
  const node = context.createAnalyser()
  node.fftSize = 1024
  source.connect(node)
  const samples = new Float32Array(node.fftSize)
  return () => {
    node.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
  }
}
function meter(current) {
  const seconds = Math.floor((performance.now() - current.startedAt) / 1000)
  $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const input = current.inputLevel?.() || 0
  const output = current.outputLevel?.() || 0
  $('app').style.setProperty('--level', Math.min(1, Math.max(muted ? 0 : input, output) * 5))
}

async function connect() {
  if (active || closing || connecting) return
  const auth = headers()
  const current = new BrowserWebRtcConnection({ sessionId: $('session').value.trim(), takeover: $('takeover').checked,
    audio: $('remote'),
    fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...auth, ...init.headers } }),
    onEvent: event => received(current, event),
    onState: value => { if (active === current && value === 'disconnected') void disconnect() },
    onError: error => { notice(error.message); log(error.message) },
    onPlayback: value => {
      if (active !== current) return
      if (value === 'speaking') state('speaking', '正在说话')
      else { $('ack').disabled = true; listening() }
    },
  })
  current.startedAt = performance.now()
  active = current
  connecting = true
  controls()
  notice()
  state('connecting', '正在建立连接')
  try {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(current.sessionId)) throw new Error('会话 ID 仅支持字母、数字、点、冒号、下划线和横线')
    const config = await loadConfiguration()
    if (active !== current) return
    try { localStorage.setItem(historyKey, current.sessionId) } catch {}
    await current.connect()
    if (active !== current || current.closed) return
    await current.activateAudio()
    await current.setMicrophoneEnabled(!muted)
    if (active !== current) return
    if (current.microphone) current.inputLevel = analyser(current.context, current.microphone)
    if ($('camera').checked && config.video_input) {
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 10, max: 15 } } })
      if (active !== current) { camera.getTracks().forEach(track => track.stop()); return }
      current.camera = camera
      await current.setVideoTrack(camera.getVideoTracks()[0])
      $('preview').srcObject = camera
    }
    $('camera-panel').hidden = !current.camera
    current.meter = setInterval(() => { if (active === current) meter(current) }, 50)
  } catch (error) {
    if (active === current) {
      await disconnect()
      const detail = error.name === 'NotAllowedError' ? '未获得麦克风或摄像头权限，请在浏览器地址栏允许访问后重试。' : error.message
      notice(detail); log(detail); state('error', '连接失败，可重试')
    }
  } finally { connecting = false; controls() }
}

$('connect').onclick = () => void connect()
$('disconnect').onclick = () => void disconnect()
$('interrupt').onclick = () => active?.interrupt()
$('orb').onclick = () => { if (!active) void connect(); else if (active.ready) active.interrupt() }
$('mute').onclick = () => {
  muted = !muted
  $('mute').setAttribute('aria-pressed', String(muted))
  $('mute').querySelector('span').textContent = muted ? '麦克风已静音' : '麦克风开启'
  active?.setMicrophoneEnabled(!muted).catch(error => notice(error.message))
  listening()
}
$('camera').onchange = async () => { if (active) { await disconnect(); await connect() } }
$('settings-toggle').onclick = () => {
  $('settings-panel').hidden = !$('settings-panel').hidden
  $('settings-toggle').setAttribute('aria-expanded', String(!$('settings-panel').hidden))
}
$('new-session').onclick = async () => {
  const reconnect = Boolean(active)
  await disconnect()
  $('session').value = crypto.randomUUID()
  try { localStorage.setItem(historyKey, $('session').value) } catch {}
  messages = []; renderMessages(); notice()
  if (reconnect) await connect()
}
$('message').onsubmit = event => {
  event.preventDefault()
  const text = $('text').value.trim()
  if (!text || !active?.ready) return
  if (!send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })) return
  send({ type: 'response.create' })
  messages.push({ id: `local:${crypto.randomUUID()}`, role: 'user', content: text, pending: true })
  renderMessages()
  $('messages').scrollTop = $('messages').scrollHeight
  $('text').value = ''
  state('processing', '正在思考')
}
$('text').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message').requestSubmit() }
}
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('text').value = button.dataset.prompt; $('text').focus() }
$('ack').onclick = () => {
  for (const [responseId, output] of active?.outputs || []) { if (!output.started) receipt('started', responseId); receipt('ended', responseId) }
  active?.outputs.clear(); $('ack').disabled = true; listening()
}
window.addEventListener('pagehide', () => { void disconnect() })
controls()
void loadConfiguration().catch(error => { log(error.message); $('model-note').textContent = '无法读取模型信息，请检查网关状态或在连接设置中填写访问凭证。' })
