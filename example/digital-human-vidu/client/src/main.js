import { GatewayVoiceConnection } from './gateway-voice.js'
import { createStreamingResampler, decodePcm, pcmBase64 } from '../../../../web/src/realtime/audio.js'
import { createTransientNotice } from './notice.mjs'

const $ = id => document.getElementById(id)
const overlayMode = new URLSearchParams(location.search).get('overlay') === '1'
document.documentElement.classList.toggle('overlay', overlayMode)
let active = null
let ending = false
let configured = false
let microphoneMuted = false
const messages = new Map()

function status(value) {
  $('status').textContent = value
  $('app').dataset.state = value.includes('失败') || value.includes('错误') ? 'error'
    : value.includes('说话') ? 'speaking'
      : value.includes('思考') ? 'thinking'
        : value.includes('连接') || value.includes('准备') || value.includes('创建') || value.includes('加入') ? 'connecting'
          : value.includes('聆听') ? 'listening' : 'idle'
}
const notice = createTransientNotice(value => {
  $('notice-text').textContent = value
  $('notice').hidden = !value
})
function setSettingsOpen(open) {
  $('overlay-settings').hidden = !open
  $('settings-gear').setAttribute('aria-expanded', String(open))
}
function audioDiagnostic(session, message) {
  if (active !== session || session.ended) return
  $('rtc-audio-status').textContent = message
  const lines = $('rtc-audio-events').textContent.split('\n').filter(Boolean)
  lines.push(`${new Date().toLocaleTimeString()} ${message}`)
  $('rtc-audio-events').textContent = lines.slice(-12).join('\n')
  console.info('[Vidu RTC audio]', message)
}
function controls(connected) {
  $('connect').disabled = connected || !configured
  $('disconnect').disabled = !connected
  $('message').disabled = !connected
  $('send').disabled = !connected
  $('interrupt').disabled = !connected
  $('microphone').disabled = !connected
  $('microphone').textContent = microphoneMuted ? '打开麦克风' : '静音麦克风'
}
async function request(url, options) {
  const response = await fetch(url, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
async function imageUri() {
  const file = $('image-file').files[0]
  if (!file) return $('image-url').value.trim()
  if (file.size > 4 * 1024 * 1024) throw new Error('本地图片请控制在 4 MB 以内')
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}
function current(session) {
  if (active !== session || session.ended) throw new Error('会话已结束')
}
function control(session, message) {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message))
}
function pcmBytes(base64) {
  const binary = atob(base64)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
function sendAudio(session, gatewayEvent) {
  if (!session.componentReady || session.socket?.readyState !== WebSocket.OPEN) return
  const rate = Number(gatewayEvent.sampleRate || 24000)
  let bytes
  if (rate === 24000) bytes = pcmBytes(gatewayEvent.audio)
  else {
    const samples = session.resampler.process(decodePcm(gatewayEvent.audio), rate, 24000)
    if (!samples.length) return
    bytes = pcmBytes(pcmBase64(samples))
  }
  if (session.socket.bufferedAmount > 2 * 1024 * 1024) {
    notice('数字人音频链路拥塞，已结束会话')
    end(session)
    return
  }
  session.socket.send(bytes)
}
function showTranscript(event) {
  if (typeof event.content !== 'string' || !event.content) return
  const id = `${event.role}:${event.responseId || event.turnId || 'current'}`
  let entry = messages.get(id)
  if (!entry) {
    entry = document.createElement('p')
    entry.className = event.role === 'user' ? 'user' : 'assistant'
    const label = document.createElement('small')
    label.textContent = event.role === 'user' ? '你' : 'Agent'
    entry.append(label, document.createTextNode(''))
    $('messages').append(entry)
    messages.set(id, entry)
  }
  entry.lastChild.textContent = event.content
  $('messages').scrollTop = $('messages').scrollHeight
}
function onGatewayEvent(session, event) {
  if (active !== session || session.ended) return
  if (event.type === 'voice.ready' || (event.type === 'voice.connection' && event.state === 'connected')) {
    session.voiceReady = true
    session.resolveVoice?.()
  }
  if (event.type === 'audio.delta') sendAudio(session, event)
  if (event.type === 'transcript.delta' || event.type === 'transcript.final') {
    showTranscript(event)
    if (event.type === 'transcript.final' && event.role === 'assistant') {
      control(session, { action: 'transcript', role: 'output', content: event.content })
    }
  }
  if (event.type === 'playback.clear' || event.type === 'response.interrupted'
    || (event.type === 'voice.state' && event.state === 'listening')) {
    session.resampler.reset()
    control(session, { action: 'interrupt' })
  }
  if (event.type === 'task.permission.requested' || event.type === 'task.input.requested') {
    notice('工具需要确认或补充信息，请在 Gateway WebUI 中处理任务')
  }
  if (event.type === 'error') notice(event.message || 'Gateway 语音错误')
}
async function connectGateway(session) {
  // Never attach a new avatar to a previous Gateway conversation/history.
  const sessionId = crypto.randomUUID()
  const voice = new GatewayVoiceConnection({
    sessionId, tools: [],
    onEvent: event => onGatewayEvent(session, event),
    onState: state => {
      if (active !== session || session.ended) return
      if (state === 'processing') status('Agent 正在思考')
      if (state === 'listening' && session.componentReady) status(microphoneMuted ? '麦克风已静音' : '正在聆听')
      if (state === 'disconnected' || state === 'error') { notice('Gateway 语音连接中断'); end(session) }
    },
    onPlayback: state => {
      if (active === session && !session.ended && session.componentReady) status(state === 'speaking' ? 'Agent 正在说话' : '正在聆听')
    },
    onError: error => {
      if (active !== session || session.ended) return
      session.rejectVoice?.(error)
      notice(error.message)
    },
  })
  session.voice = voice
  await voice.setMicrophoneEnabled(false)
  const ready = new Promise((resolve, reject) => {
    session.resolveVoice = resolve
    session.rejectVoice = reject
    session.voiceTimer = setTimeout(() => reject(new Error('Gateway 语音连接超时')), 30000)
  })
  await Promise.all([voice.connect(), ready]).finally(() => clearTimeout(session.voiceTimer))
  current(session)
}
async function connectComponent(session) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/vidu/ws/session?session_id=${encodeURIComponent(session.data.session_id)}`)
  session.socket = socket
  return await new Promise((resolve, reject) => {
    let settled = false
    session.cancelComponent = () => { if (!settled) { settled = true; reject(new Error('会话已结束')) } }
    function fail(message) {
      if (!settled) { settled = true; reject(new Error(message)) }
      else { notice(message); end(session, false) }
    }
    session.componentTimer = setTimeout(() => fail('数字人初始化超时'), 65000)
    socket.addEventListener('message', ({ data }) => {
      if (active !== session || session.ended) return
      let message
      try { message = JSON.parse(data) } catch { return }
      if (message.event === 'ready') {
        settled = true
        clearTimeout(session.componentTimer)
        session.componentReady = true
        resolve()
      } else if (message.event === 'warming') status('数字人准备中')
      else if (message.event === 'error') fail(message.message)
      else if (message.event === 'ended') fail(message.reason)
    })
    socket.addEventListener('close', () => { if (!session.ended) fail('数字人连接关闭') })
    socket.addEventListener('error', () => { if (!session.ended) fail('数字人连接错误') })
  })
}
async function joinRtc(session) {
  const Engine = window.AliRtcEngine
  if (!Engine?.getInstance) throw new Error('AliRTC Web SDK 加载失败')
  const support = await Engine.isSupported()
  if (!support.support) throw new Error('当前浏览器不支持 AliRTC')
  current(session)
  const engine = Engine.getInstance()
  session.engine = engine
  const avatarId = session.data.rtc.avatar_user_id
  const noAudioTrack = Engine.AliRtcAudioTrack?.AliRtcAudioTrackNo ?? 0
  const subscribed = Engine.AliRtcSubscribeState?.AliRtcSubscribeStateSubscribed ?? 3
  engine.on('remoteTrackAvailableNotify', (userId, audioTrack, videoTrack) => {
    if (userId === avatarId) audioDiagnostic(session, `数字人${audioTrack === noAudioTrack ? '未发布音轨' : '已发布音轨'}：audio=${audioTrack}，video=${videoTrack}`)
  })
  engine.on('remoteUserOnLineNotify', userId => {
    if (userId === avatarId) audioDiagnostic(session, '数字人已加入 ARTC 频道，等待自动订阅音频')
  })
  engine.on('audioSubscribeStateChanged', (userId, previous, next) => {
    if (userId !== avatarId || active !== session || session.ended) return
    audioDiagnostic(session, `数字人音频订阅：${previous} → ${next}${next === subscribed ? '（已订阅）' : ''}`)
    if (next !== subscribed) return
    session.avatarAudioSubscribed = true
    try {
      engine.setRemoteAudioVolume(avatarId, 100)
      audioDiagnostic(session, '数字人远端音量设为 100；本地 Agent 回复保持静音')
    } catch (error) {
      audioDiagnostic(session, `设置远端音量失败：${error.message}`)
      notice('数字人声音设置失败，请查看远端音频诊断')
    }
  })
  engine.on('remoteAudioAutoPlayFail', userId => {
    if (userId && userId !== avatarId) return
    audioDiagnostic(session, '浏览器阻止了远端音频自动播放')
    notice('浏览器阻止了数字人声音自动播放；请允许此站点播放声音后重新开始对话')
  })
  engine.on('remoteAudioPlayError', (userId, error) => {
    if (userId !== avatarId) return
    audioDiagnostic(session, `远端音频播放错误：${error?.message || error || '未知错误'}`)
    notice('数字人声音播放失败，请查看远端音频诊断')
  })
  engine.on('rtcRemoteAudioStats', stats => {
    if (!Array.isArray(stats) || !stats.length) return
    const avatarStats = stats.find(item => item.uid === avatarId || item.userId === avatarId) || stats[0]
    audioDiagnostic(session, `远端音频统计：${JSON.stringify(avatarStats).slice(0, 600)}`)
  })
  const subscribe = (userId, newState, streamType) => {
    if (active !== session || session.ended || userId !== session.data.rtc.avatar_user_id || newState !== 3) return
    engine.setRemoteViewConfig($('remote'), userId, streamType)
    $('stage-label').hidden = true
    $('remote').play().then(() => notice()).catch(() => notice('请点击画面以启用播放'))
  }
  engine.on('videoSubscribeStateChanged', (userId, _previous, next) => subscribe(userId, next, 1))
  engine.on('screenShareSubscribeStateChanged', (userId, _previous, next) => subscribe(userId, next, 2))
  engine.on('authInfoExpired', () => { if (active === session) { notice('RTC 凭证已过期'); end(session) } })
  engine.on('bye', () => { if (active === session) end(session) })
  await engine.setChannelProfile('communication')
  await engine.setAudioOnlyMode(false)
  // The Gateway owns microphone input. This component client only subscribes
  // to avatar media; do not capture or publish local microphone/camera tracks.
  await engine.publishLocalAudioStream(false)
  await engine.publishLocalVideoStream(false)
  await engine.enableLocalVideo(false)
  // The avatar may join RTC after us. Configure automatic subscription before
  // joining instead of subscribing to a UID that is not online yet.
  await engine.setDefaultSubscribeAllRemoteAudioStreams(true)
  await engine.setDefaultSubscribeAllRemoteVideoStreams(true)
  current(session)
  await engine.joinChannel(session.data.rtc.token, session.data.rtc.user_id)
  current(session)
  if (!session.avatarAudioSubscribed) audioDiagnostic(session, '已加入 ARTC 频道，等待数字人音轨自动订阅')
}
async function start() {
  if (active || ending) return
  const session = {
    ended: false,
    componentReady: false,
    resampler: createStreamingResampler(),
  }
  active = session
  messages.clear()
  $('messages').replaceChildren()
  $('rtc-audio-status').textContent = '等待加入 ARTC 频道'
  $('rtc-audio-events').textContent = ''
  $('connect').disabled = true
  $('disconnect').disabled = false
  notice()
  status('连接本地 Agent')
  try {
    const image = await imageUri()
    if (!image) throw new Error('请先在设置中选择角色图片')
    current(session)
    await connectGateway(session)
    current(session)
    status('创建数字人')
    session.data = await request('/vidu/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_uri: image }),
    })
    if (session.ended) {
      await request(`/vidu/api/session/${encodeURIComponent(session.data.session_id)}`, { method: 'DELETE' })
      return
    }
    current(session)
    await connectComponent(session)
    current(session)
    status('加入数字人频道')
    session.joinTask = joinRtc(session)
    await session.joinTask
    current(session)
    await session.voice.setMicrophoneEnabled(true)
    current(session)
    microphoneMuted = false
    controls(true)
    setSettingsOpen(false)
    status('正在聆听')
  } catch (error) {
    if (active === session) { notice(error.message); await end(session) }
  }
}
async function end(session, hangup = true) {
  if (!session || session.ended) return
  session.ended = true
  active = null
  ending = true
  controls(false)
  status('结束对话中')
  clearTimeout(session.voiceTimer)
  clearTimeout(session.componentTimer)
  session.rejectVoice?.(new Error('会话已结束'))
  session.cancelComponent?.()
  if (hangup) control(session, { action: 'hangup' })
  if (session.socket?.readyState === WebSocket.CONNECTING) session.socket.addEventListener('open', () => {
    session.socket.send(JSON.stringify({ action: 'hangup' }))
    session.socket.close()
  }, { once: true })
  else session.socket?.close()
  await session.joinTask?.catch(() => {})
  if (session.engine) for (const method of ['leaveChannel', 'destroy']) {
    try { await session.engine[method]?.() } catch { /* continue */ }
  }
  await session.voice?.close()
  if (session.data) await request(`/vidu/api/session/${encodeURIComponent(session.data.session_id)}`, { method: 'DELETE' }).catch(() => {})
  session.resampler.reset()
  $('remote').srcObject = null
  $('stage-label').hidden = false
  $('rtc-audio-status').textContent = '尚未连接'
  status('未连接')
  ending = false
  controls(false)
}

$('connect').addEventListener('click', start)
$('settings-gear').addEventListener('click', () => setSettingsOpen($('overlay-settings').hidden))
$('settings-close').addEventListener('click', () => setSettingsOpen(false))
$('notice-close').addEventListener('click', () => notice())
$('switch-orb').hidden = !window.viduAvatarDesktop
$('switch-orb').addEventListener('click', async () => {
  await end(active)
  window.viduAvatarDesktop?.switchToOrb()
})
$('quit').hidden = !overlayMode
$('quit').addEventListener('click', async () => {
  await end(active)
  window.viduAvatarDesktop?.quit()
})
$('remote').addEventListener('click', () => {
  $('remote').play().then(() => notice()).catch(() => notice('视频播放被浏览器阻止，请允许此站点自动播放'))
})
$('disconnect').addEventListener('click', () => end(active))
$('chat').addEventListener('submit', submitEvent => {
  submitEvent.preventDefault()
  const content = $('message').value.trim()
  if (!content || !active?.voice?.ready) return
  active.voice.interrupt()
  control(active, { action: 'interrupt' })
  if (active.voice.sendText(content)) $('message').value = ''
})
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    $('chat').requestSubmit()
  }
})
$('interrupt').addEventListener('click', () => { if (active) { active.voice.interrupt(); control(active, { action: 'interrupt' }) } })
$('microphone').addEventListener('click', async () => {
  const session = active
  if (!session) return
  try {
    const next = !microphoneMuted
    await session.voice.setMicrophoneEnabled(!next)
    if (active !== session || session.ended) return
    microphoneMuted = next
    controls(true)
    status(microphoneMuted ? '麦克风已静音' : '正在聆听')
  } catch (error) { notice(error.message) }
})
window.addEventListener('pagehide', () => {
  if (active?.socket?.readyState === WebSocket.OPEN) control(active, { action: 'hangup' })
  active?.socket?.close()
  active?.voice?.close()
  if (active?.data) fetch(`/vidu/api/session/${encodeURIComponent(active.data.session_id)}`, { method: 'DELETE', keepalive: true }).catch(() => {})
})
request('/vidu/api/config').then(config => {
  configured = config.configured
  controls(false)
  status(configured ? '未连接' : '缺少密钥配置')
  if (!configured) notice('请配置 VIDU_API_KEY、ARTC_APP_ID 和 ARTC_APP_KEY')
}).catch(error => notice(error.message))
