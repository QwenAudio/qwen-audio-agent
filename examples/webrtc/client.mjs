// Browser-only WebRTC client. The model is selected when starting the Gateway.
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
  const channel = active?.channel
  if (channel?.readyState !== 'open') return false
  channel.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event }))
  return true
}
function receipt(type, responseId) { send({ type: `qwaudio.playback.${type}`, response_id: responseId }) }
function enableTracks(current) {
  for (const track of current.stream?.getTracks() || []) {
    track.enabled = current.ready && !current.suspended && (track.kind !== 'audio' || !muted)
  }
}
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
    current.abort.abort()
    clearInterval(current.meter)
    clearTimeout(current.unmute)
    for (const track of current.stream?.getTracks() || []) track.stop()
    current.pc?.close()
    await current.context?.close().catch(() => {})
    $('remote').srcObject = null
    $('preview').srcObject = null
    $('camera-panel').hidden = true
    $('ack').disabled = true
    $('elapsed').textContent = '00:00'
    $('app').style.setProperty('--level', 0)
    for (const message of messages) message.live = false
    renderMessages()
    if (current.location) await fetch(current.location, { method: 'DELETE', headers: current.headers, signal: AbortSignal.timeout(3000) }).catch(() => {})
    state('idle', '已断开')
  })()
  controls()
  try { await closing } finally { closing = null; controls() }
}

function received(current, event) {
  if (active !== current) return
  log(event)
  if (event.type === 'session.updated') {
    current.ready = true
    enableTracks(current)
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
    current.outputs.set(event.response_id, { started: false, drained: 0, quiet: 0 })
    $('ack').disabled = false
  }
  if (event.type === 'qwaudio.output.drained') {
    const output = current.outputs.get(event.response_id)
    if (output) output.drained = performance.now()
  }
  if (event.type === 'output_audio_buffer.cleared') {
    for (const responseId of current.outputs.keys()) receipt('cancelled', responseId)
    current.outputs.clear()
    for (const message of messages) if (message.live && message.role === 'assistant') { message.live = false; message.interrupted = true }
    renderMessages()
    $('remote').muted = true
    clearTimeout(current.unmute)
    current.unmute = setTimeout(() => { if (active === current) $('remote').muted = false }, 400)
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
    if (['input.suspend', 'input.resume'].includes(item.type)) { current.suspended = item.type === 'input.suspend'; enableTracks(current) }
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

async function gather(pc) {
  if (pc.iceGatheringState === 'complete') return
  await new Promise((resolve, reject) => {
    const changed = () => {
      if (pc.iceGatheringState !== 'complete') return
      clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve()
    }
    const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', changed); reject(new Error('ICE gathering timeout')) }, 12000)
    pc.addEventListener('icegatheringstatechange', changed)
    changed()
  })
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
  if ($('remote').paused || $('remote').muted || current.context.state !== 'running') return
  const first = current.outputs.entries().next().value
  if (!first) return
  const [responseId, playback] = first
  const now = performance.now()
  if (output > 0.002) {
    playback.quiet = 0
    if (!playback.started) { playback.started = true; receipt('started', responseId); state('speaking', '正在说话') }
  } else playback.quiet ||= now
  if (playback.started && playback.drained && now - playback.drained > 500 && playback.quiet && now - playback.quiet > 300) {
    receipt('ended', responseId)
    current.outputs.delete(responseId)
    if (!current.outputs.size) { $('ack').disabled = true; listening() }
  }
}

async function connect() {
  if (active || closing || connecting) return
  const current = { headers: headers(), sessionId: $('session').value.trim(), abort: new AbortController(), outputs: new Map(), ready: false, startedAt: performance.now() }
  active = current
  connecting = true
  controls()
  notice()
  state('connecting', '正在建立连接')
  try {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(current.sessionId)) throw new Error('会话 ID 仅支持字母、数字、点、冒号、下划线和横线')
    current.context = new AudioContext()
    await current.context.resume()
    const config = await loadConfiguration()
    if (active !== current) return
    try { localStorage.setItem(historyKey, current.sessionId) } catch {}
    current.pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
    current.pc.onconnectionstatechange = () => {
      if (active !== current) return
      log(`peer: ${current.pc.connectionState}`)
      if (current.pc.connectionState === 'failed') { notice('媒体连接中断，请重新连接'); void disconnect() }
    }
    current.pc.ondatachannel = ({ channel }) => {
      if (channel.label !== 'txt') return
      current.channel = channel
      channel.onmessage = ({ data }) => { try { received(current, JSON.parse(data)) } catch (error) { log(error.message) } }
      channel.onclose = () => { if (active === current) void disconnect() }
    }
    current.pc.createDataChannel('oai-events', { ordered: true })
    current.pc.ontrack = async ({ track }) => {
      if (track.kind !== 'audio' || active !== current) return
      const stream = new MediaStream([track])
      $('remote').srcObject = stream
      $('remote').muted = false
      current.outputLevel = analyser(current.context, stream)
      try { await $('remote').play() }
      catch { $('diagnostics').open = true; notice('浏览器阻止了自动播放，请点击下方播放器的播放按钮。') }
    }
    current.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      video: $('camera').checked && config.video_input ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 10, max: 15 } } : false,
    })
    if (active !== current) { current.stream.getTracks().forEach(track => track.stop()); return }
    current.inputLevel = analyser(current.context, current.stream)
    for (const track of current.stream.getTracks()) { track.enabled = false; current.pc.addTrack(track, current.stream) }
    $('camera-panel').hidden = !current.stream.getVideoTracks().length
    $('preview').srcObject = current.stream
    current.meter = setInterval(() => { if (active === current) meter(current) }, 50)
    await current.pc.setLocalDescription(await current.pc.createOffer())
    await gather(current.pc)
    const query = new URLSearchParams({ sessionId: current.sessionId, model: config.model })
    if ($('takeover').checked) query.set('takeover', 'true')
    const answer = await fetch(`/api/v1/webrtc/realtime?${query}`, {
      method: 'POST', headers: { ...current.headers, 'Content-Type': 'application/sdp' },
      body: current.pc.localDescription.sdp, signal: current.abort.signal,
    })
    if (!answer.ok) throw new Error((await answer.json()).error?.message || `HTTP ${answer.status}`)
    current.location = answer.headers.get('Location')
    await current.pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
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
$('interrupt').onclick = () => send({ type: 'response.cancel' })
$('orb').onclick = () => { if (!active) void connect(); else if (active.ready) send({ type: 'response.cancel' }) }
$('mute').onclick = () => {
  muted = !muted
  $('mute').setAttribute('aria-pressed', String(muted))
  $('mute').querySelector('span').textContent = muted ? '麦克风已静音' : '麦克风开启'
  if (active) enableTracks(active)
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
window.addEventListener('pagehide', () => { active?.pc?.close(); active?.stream?.getTracks().forEach(track => track.stop()); clearInterval(active?.meter) })
controls()
void loadConfiguration().catch(error => { log(error.message); $('model-note').textContent = '无法读取模型信息，请检查网关状态或在连接设置中填写访问凭证。' })
