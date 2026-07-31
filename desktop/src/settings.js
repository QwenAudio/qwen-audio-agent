const form = document.querySelector('#settings-form')
const gatewayUrl = document.querySelector('#gateway-url')
const orbStyle = document.querySelector('#orb-style')
const dashscopeApiKey = document.querySelector('#dashscope-api-key')
const agentProtocol = document.querySelector('#agent-protocol')
const realtimeModel = document.querySelector('#realtime-model')
const backendModel = document.querySelector('#backend-model')
const getApiKey = document.querySelector('#get-api-key')
const message = document.querySelector('#message')
const currentRealtime = document.querySelector('#current-realtime')
const currentGateway = document.querySelector('#current-gateway')
const currentBackend = document.querySelector('#current-backend')
const submit = form.querySelector('button[type="submit"]')

let settings
let runtime
let appliedFingerprint = ''
let applying = false
let refreshingRuntime = false

function showMessage(text, kind = '') {
  message.textContent = text
  message.className = kind
}

function friendlyError(error, fallback) {
  return String(error?.message || fallback).replace(
    /^Error invoking remote method '[^']+': Error:\s*/,
    '',
  )
}

function backendLabel(value) {
  if (!value || value === 'none') return '未配置'
  if (value === 'opencode') return 'OpenCode'
  if (value === 'openclaw') return 'OpenClaw'
  if (value === 'qoder') return 'Qoder'
  if (value === 'kimi') return 'Kimi Code'
  if (value === 'hermes') return 'Hermes'
  if (value === 'codebuddy') return 'CodeBuddy'
  if (value === 'codex') return 'Codex'
  if (value === 'claude') return 'Claude Code'
  if (value === 'acp') return 'ACP Agent'
  return value
}

const BAILIAN_API_KEY_URL = 'https://bailian.console.aliyun.com/?tab=model#/api-key'

function formSettings() {
  return {
    gatewayUrl: gatewayUrl.value,
    orbStyle: orbStyle.value,
    dashscopeApiKey: dashscopeApiKey.value,
    agentProtocol: agentProtocol.value,
    realtimeModel: realtimeModel.value,
    backendModel: backendModel.value,
  }
}

function fingerprint(value) {
  return JSON.stringify({
    gatewayUrl: value.gatewayUrl,
    orbStyle: value.orbStyle,
    dashscopeApiKey: value.dashscopeApiKey,
    agentProtocol: value.agentProtocol,
    realtimeModel: value.realtimeModel,
    backendModel: value.backendModel,
  })
}

function updateApplyState() {
  submit.disabled = applying || fingerprint(formSettings()) === appliedFingerprint
}

function setBackendStatus(text, connected) {
  currentBackend.textContent = text
  currentBackend.className = `connection-status ${connected ? 'connected' : 'disconnected'}`
}

function renderRuntime() {
  if (!runtime?.gatewayConnected) {
    currentGateway.textContent = '未连接'
    currentGateway.className = 'connection-status disconnected'
    currentRealtime.textContent = 'Gateway 未连接'
    setBackendStatus('未连接', false)
    return
  }

  currentGateway.textContent = '已连接'
  currentGateway.className = 'connection-status connected'
  currentRealtime.textContent = runtime.voiceConfigured
    ? runtime.realtimeModel || '默认模型'
    : '缺少凭据'
  if (!runtime.backend) {
    setBackendStatus('未配置', false)
    return
  }
  const label = runtime.backend.label
    || backendLabel(runtime.backend.protocol)
  const details = runtime.backend.baseUrl
    ? `${label} · ${runtime.backend.baseUrl}`
    : label
  setBackendStatus(details, runtime.backend.connected)
}

async function refreshRuntime() {
  if (refreshingRuntime || applying) return
  refreshingRuntime = true
  try {
    runtime = await window.qwenAudioAgentDesktop.loadRuntimeStatus()
    renderRuntime()
    if (
      runtime.gatewayConnected
      && (!runtime.backend || runtime.backend.connected)
      && message.className === 'notice'
    ) {
      showMessage('服务已连接，可以开始使用。', 'success')
    }
  } catch {
    // A Gateway restart can briefly invalidate one poll. The next poll
    // updates the UI without turning a normal restart into a visible error.
  } finally {
    refreshingRuntime = false
  }
}

function render() {
  gatewayUrl.value = settings.gatewayUrl
  orbStyle.value = settings.orbStyle
  dashscopeApiKey.value = settings.dashscopeApiKey || ''
  agentProtocol.value = settings.agentProtocol || 'none'
  realtimeModel.value = settings.realtimeModel
    || 'qwen-audio-3.0-realtime-plus'
  backendModel.value = settings.backendModel || ''
  renderRuntime()
  appliedFingerprint = fingerprint(formSettings())
  updateApplyState()
}

for (const control of [
  gatewayUrl,
  orbStyle,
  dashscopeApiKey,
  agentProtocol,
  realtimeModel,
  backendModel,
]) {
  control.addEventListener('input', () => {
    showMessage('')
    updateApplyState()
  })
  control.addEventListener('change', () => {
    showMessage('')
    updateApplyState()
  })
}

getApiKey.addEventListener('click', () => {
  window.qwenAudioAgentDesktop.openExternal(BAILIAN_API_KEY_URL)
})

form.addEventListener('submit', async event => {
  event.preventDefault()
  applying = true
  updateApplyState()
  showMessage('正在应用…')
  try {
    const result = await window.qwenAudioAgentDesktop.saveSettings(formSettings())
    settings = result.settings
    runtime = result.runtime
    render()
    if (!runtime.gatewayConnected) {
      showMessage('配置已保存，Gateway 正在启动…', 'notice')
    } else if (runtime.backend && !runtime.backend.connected) {
      showMessage('Gateway 已启动，后台 Agent 正在连接…', 'notice')
    } else {
      showMessage(
        result.restarted ? '已应用，服务已连接。' : '已应用。',
        'success',
      )
    }
  } catch (error) {
    showMessage(friendlyError(error, '应用失败'), 'error')
  } finally {
    applying = false
    updateApplyState()
  }
})

window.qwenAudioAgentDesktop.loadSettings().then(value => {
  settings = value.settings
  runtime = value.runtime
  render()
  if (value.runtimeError) {
    showMessage(`当前配置启动失败：${value.runtimeError}`, 'error')
  } else if (value.setupRequired) {
    showMessage('首次使用，请填写 API Key 并选择后台 Agent。', 'notice')
  }
}).catch(error => {
  showMessage(friendlyError(error, '读取设置失败'), 'error')
  submit.disabled = true
})

setInterval(() => {
  void refreshRuntime()
}, 2000)
