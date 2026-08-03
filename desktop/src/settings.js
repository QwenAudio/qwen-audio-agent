import { backendOptionStates } from './backend-options.mjs'
import {
  realtimeConnectionStatus,
  realtimeModelStatusLabel,
  realtimeStatusLabel,
} from './realtime-status.mjs'
import { updaterButtonState, updaterStatusText } from './update-status.mjs'

const form = document.querySelector('#settings-form')
const gatewayUrl = document.querySelector('#gateway-url')
const orbStyle = document.querySelector('#orb-style')
const dashscopeApiKey = document.querySelector('#dashscope-api-key')
const realtimeProviderInputs = [
  ...document.querySelectorAll('input[name="realtime-provider"]'),
]
const providerPanels = [
  ...document.querySelectorAll('[data-provider-panel]'),
]
const speechToSpeechRealtimeUrl = document.querySelector(
  '#speech-to-speech-url',
)
const speechToSpeechAuthToken = document.querySelector(
  '#speech-to-speech-token',
)
const agentProtocol = document.querySelector('#agent-protocol')
const refreshBackends = document.querySelector('#refresh-backends')
const realtimeModel = document.querySelector('#realtime-model')
const backendModel = document.querySelector('#backend-model')
const getApiKey = document.querySelector('#get-api-key')
const message = document.querySelector('#message')
const currentRealtime = document.querySelector('#current-realtime')
const currentGateway = document.querySelector('#current-gateway')
const currentBackend = document.querySelector('#current-backend')
const updaterStatus = document.querySelector('#updater-status')
const checkUpdates = document.querySelector('#check-updates')
const openLogs = document.querySelector('#open-logs')
const submit = form.querySelector('button[type="submit"]')

let settings
let runtime
let backendReport = null
let appliedFingerprint = ''
let applying = false
let refreshingRuntime = false
let updaterState = null
let startupError = null

// 更新状态由主进程推送（onUpdaterStatus）与打开时拉取（loadUpdaterStatus）
// 共同驱动；下载完成前按钮禁用，完成后变为“重启更新”。
function renderUpdater(status) {
  if (!status) return
  updaterState = status
  updaterStatus.textContent = updaterStatusText(status)
  updaterStatus.title = status.phase === 'error' ? status.message : ''
  const button = updaterButtonState(status)
  checkUpdates.textContent = button.label
  checkUpdates.disabled = button.disabled
}

checkUpdates.addEventListener('click', () => {
  if (updaterState?.phase === 'downloaded') {
    void window.qwenAudioAgentDesktop.installUpdate()
    return
  }
  checkUpdates.disabled = true
  window.qwenAudioAgentDesktop.checkUpdates()
    .then(renderUpdater)
    .catch(() => {
      checkUpdates.disabled = false
    })
})

openLogs.addEventListener('click', () => {
  window.qwenAudioAgentDesktop.openLogs().catch(error => {
    showMessage(friendlyError(error, '无法打开日志目录'), 'error')
  })
})

window.qwenAudioAgentDesktop.onUpdaterStatus(renderUpdater)
window.qwenAudioAgentDesktop.loadUpdaterStatus()
  .then(renderUpdater)
  .catch(() => {})

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

function truncate(text, max = 80) {
  const value = String(text || '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

// 按本机检测结果重建后台 Agent 下拉列表：可用的正常显示，不可用的
// 置灰并标注原因；当前生效的值即使不可用也保留，避免下拉框丢值。
function renderBackendOptions(currentValue) {
  const states = backendOptionStates(backendReport)
  if (currentValue && !states.some(state => state.id === currentValue)) {
    states.push({
      id: currentValue,
      label: backendLabel(currentValue),
      disabled: false,
      title: '',
    })
  }
  agentProtocol.replaceChildren(...states.map(state => {
    const option = document.createElement('option')
    option.value = state.id
    option.textContent = state.label
    option.disabled = state.disabled
    if (state.title) option.title = state.title
    return option
  }))
  agentProtocol.value = currentValue || 'none'
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

function selectedRealtimeProvider() {
  return realtimeProviderInputs.find(input => input.checked)?.value
    || 'dashscope'
}

function renderRealtimeProvider(value, { populateDefault = false } = {}) {
  const provider = value === 'speech-to-speech'
    ? 'speech-to-speech'
    : 'dashscope'
  for (const input of realtimeProviderInputs) {
    input.checked = input.value === provider
  }
  for (const panel of providerPanels) {
    panel.hidden = panel.dataset.providerPanel !== provider
  }
  if (
    populateDefault
    && provider === 'speech-to-speech'
    && !speechToSpeechRealtimeUrl.value.trim()
  ) {
    speechToSpeechRealtimeUrl.value = 'ws://127.0.0.1:8765/v1/realtime'
  }
}

const BAILIAN_API_KEY_URL = 'https://bailian.console.aliyun.com/?tab=model#/api-key'

function formSettings() {
  return {
    gatewayUrl: gatewayUrl.value,
    orbStyle: orbStyle.value,
    dashscopeApiKey: dashscopeApiKey.value,
    realtimeProvider: selectedRealtimeProvider(),
    agentProtocol: agentProtocol.value,
    realtimeModel: realtimeModel.value,
    speechToSpeechRealtimeUrl: speechToSpeechRealtimeUrl.value,
    speechToSpeechAuthToken: speechToSpeechAuthToken.value,
    backendModel: backendModel.value,
  }
}

function fingerprint(value) {
  return JSON.stringify({
    gatewayUrl: value.gatewayUrl,
    orbStyle: value.orbStyle,
    dashscopeApiKey: value.dashscopeApiKey,
    realtimeProvider: value.realtimeProvider,
    agentProtocol: value.agentProtocol,
    realtimeModel: value.realtimeModel,
    speechToSpeechRealtimeUrl: value.speechToSpeechRealtimeUrl,
    speechToSpeechAuthToken: value.speechToSpeechAuthToken,
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

function setRealtimeStatus(text, state) {
  currentRealtime.textContent = text
  currentRealtime.className = state === 'configured'
    ? ''
    : `connection-status ${state === 'connected' ? 'connected' : state === 'connecting' ? 'checking' : 'unavailable'}`
}

function renderRuntime() {
  if (!runtime?.gatewayConnected) {
    currentGateway.textContent = '未连接'
    currentGateway.className = 'connection-status disconnected'
    setRealtimeStatus('Gateway 未连接', 'disconnected')
    setBackendStatus('未连接', false)
    return
  }

  currentGateway.textContent = '已连接'
  currentGateway.className = 'connection-status connected'
  const realtimeLabel = realtimeStatusLabel(runtime.realtimeProvider)
  const realtimeModelLabel = realtimeModelStatusLabel(runtime.realtimeModel)
  if (!runtime.voiceConfigured) {
    setRealtimeStatus(`${realtimeLabel} · 配置不完整`, 'disconnected')
  } else {
    const state = realtimeConnectionStatus(
      runtime.realtimeConnection?.byProvider?.[runtime.realtimeProvider],
    )
    const stateLabel = {
      connected: '已连接',
      connecting: '正在连接',
      unavailable: '连接失败',
      disconnected: '连接异常',
      configured: '已配置',
    }[state]
    setRealtimeStatus(
      [
        realtimeLabel,
        realtimeModelLabel,
        stateLabel,
        state === 'unavailable'
          ? truncate(
            runtime.realtimeConnection?.byProvider?.[runtime.realtimeProvider]?.error,
          )
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      state,
    )
  }
  if (!runtime.backend) {
    setBackendStatus('未配置', false)
    return
  }
  const label = runtime.backend.label
    || backendLabel(runtime.backend.protocol)
  if (!runtime.backend.connected && runtime.backend.error) {
    const reason = String(runtime.backend.error).trim()
    setBackendStatus(`${label} 未连接：${truncate(reason)}`, false)
    currentBackend.title = reason
    return
  }
  currentBackend.title = ''
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
      startupError
      && runtime.gatewayConnected
      && (!runtime.backend || runtime.backend.connected)
    ) {
      // 启动失败已被自动重启等机制恢复，清掉残留的错误提示，
      // 避免“显示报错”与“实际已连接”并存。
      startupError = null
      showMessage('Gateway 已自动恢复。', 'success')
    } else if (
      runtime.gatewayConnected
      && (!runtime.backend || runtime.backend.connected)
      && message.className === 'notice'
    ) {
      showMessage('配置已应用，Gateway 已启动。', 'success')
    }
  } catch {
    // A Gateway restart can briefly invalidate one poll. The next poll
    // updates the UI without turning a normal restart into a visible error.
  } finally {
    refreshingRuntime = false
  }
}

async function detectBackendOptions(force = false) {
  refreshBackends.disabled = true
  try {
    backendReport = await window.qwenAudioAgentDesktop.detectBackends(
      force ? { force: true } : undefined,
    )
    renderBackendOptions(agentProtocol.value || settings?.agentProtocol)
    updateApplyState()
  } catch (error) {
    showMessage(friendlyError(error, '检测后台 Agent 失败'), 'error')
  } finally {
    refreshBackends.disabled = false
  }
}

refreshBackends.addEventListener('click', () => {
  void detectBackendOptions(true)
})

function render() {
  gatewayUrl.value = settings.gatewayUrl
  orbStyle.value = settings.orbStyle
  dashscopeApiKey.value = settings.dashscopeApiKey || ''
  renderBackendOptions(settings.agentProtocol || 'none')
  realtimeModel.value = settings.realtimeModel
    || 'qwen-audio-3.0-realtime-plus'
  speechToSpeechRealtimeUrl.value = settings.speechToSpeechRealtimeUrl || ''
  speechToSpeechAuthToken.value = settings.speechToSpeechAuthToken || ''
  renderRealtimeProvider(settings.realtimeProvider)
  backendModel.value = settings.backendModel || ''
  renderRuntime()
  appliedFingerprint = fingerprint(formSettings())
  updateApplyState()
}

for (const control of [
  gatewayUrl,
  orbStyle,
  dashscopeApiKey,
  speechToSpeechRealtimeUrl,
  speechToSpeechAuthToken,
  agentProtocol,
  realtimeModel,
  backendModel,
  ...realtimeProviderInputs,
]) {
  control.addEventListener('input', () => {
    showMessage('')
    updateApplyState()
  })
  control.addEventListener('change', () => {
    showMessage('')
    if (realtimeProviderInputs.includes(control)) {
      renderRealtimeProvider(control.value, { populateDefault: true })
    }
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
        result.restarted ? '已应用，Gateway 已启动。' : '已应用。',
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
  void detectBackendOptions()
  if (value.runtimeError) {
    startupError = value.runtimeError
    showMessage(`当前配置启动失败：${value.runtimeError}`, 'error')
  } else if (value.setupRequired) {
    showMessage('首次使用，请配置语音引擎并选择后台 Agent。', 'notice')
  }
}).catch(error => {
  showMessage(friendlyError(error, '读取设置失败'), 'error')
  submit.disabled = true
})

setInterval(() => {
  void refreshRuntime()
}, 2000)
