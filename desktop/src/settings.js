import {
  backendOptionStates,
  backendRuntimeReady,
} from './backend-options.mjs'
import {
  realtimeConnectionStatus,
  realtimeModelStatusLabel,
  realtimeStatusLabel,
} from './realtime-status.mjs'
import { updaterButtonState, updaterStatusText } from './update-status.mjs'

const form = document.querySelector('#settings-form')
const gatewayUrl = document.querySelector('#gateway-url')
const orbStyle = document.querySelector('#orb-style')
const autoHideSeconds = document.querySelector('#auto-hide-seconds')
const wakeShortcut = document.querySelector('#wake-shortcut')
const recordWakeShortcut = document.querySelector('#record-wake-shortcut')
const resetWakeShortcut = document.querySelector('#reset-wake-shortcut')
const wakeWordEnabled = document.querySelector('#wake-word-enabled')
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
const backendList = document.querySelector('#backend-list')
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
const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')]
const settingsPanels = [...document.querySelectorAll('[data-settings-panel]')]

let settings
let runtime
let backendReport = null
let appliedFingerprint = ''
let applying = false
let refreshingRuntime = false
let updaterState = null
let startupError = null
let recordingWakeShortcut = false
const defaultWakeShortcut = 'CommandOrControl+Shift+Space'
const macPlatform = /Mac|iPhone|iPad/.test(navigator.platform)

function selectSettingsTab(value, { focus = false } = {}) {
  const selected = settingsTabs.some(tab => tab.dataset.settingsTab === value)
    ? value
    : 'voice'
  for (const tab of settingsTabs) {
    const active = tab.dataset.settingsTab === selected
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    if (active && focus) tab.focus()
  }
  for (const panel of settingsPanels) {
    panel.hidden = panel.dataset.settingsPanel !== selected
  }
  localStorage.setItem('qwen-audio-agent.settings-tab', selected)
}

for (const tab of settingsTabs) {
  tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const current = settingsTabs.indexOf(tab)
    const offset = event.key === 'ArrowRight' ? 1 : -1
    const next = (current + offset + settingsTabs.length) % settingsTabs.length
    selectSettingsTab(settingsTabs[next].dataset.settingsTab, { focus: true })
  })
}
selectSettingsTab(localStorage.getItem('qwen-audio-agent.settings-tab'))

function renderWakeShortcutStatus(registered) {
  recordWakeShortcut.classList.toggle('invalid', registered === false)
  recordWakeShortcut.title = registered === false
    ? '这个显示快捷键已被其他应用占用，点击重新设置'
    : '点击后按下新的快捷键'
}

function wakeShortcutLabel(value) {
  if (macPlatform && value === defaultWakeShortcut) return '⇧  ⌘  Space'
  const labels = {
    CommandOrControl: macPlatform ? '⌘' : 'Ctrl',
    Alt: macPlatform ? '⌥' : 'Alt',
    Shift: '⇧',
    Space: 'Space',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
  }
  return String(value || defaultWakeShortcut)
    .split('+')
    .map(part => labels[part] || part)
    .join('  ')
}

function renderWakeShortcut() {
  recordWakeShortcut.textContent = recordingWakeShortcut
    ? '请按快捷键…'
    : wakeShortcutLabel(wakeShortcut.value)
  recordWakeShortcut.classList.toggle('recording', recordingWakeShortcut)
  resetWakeShortcut.hidden = wakeShortcut.value === defaultWakeShortcut
}

async function restoreWakeShortcutRegistration() {
  try {
    const registered = await window.qwenAudioAgentDesktop.resumeWakeShortcut()
    renderWakeShortcutStatus(registered)
  } catch {
    renderWakeShortcutStatus(false)
  }
}

function capturedWakeShortcut(event) {
  let key = event.key
  if (key === ' ') key = 'Space'
  if (key.startsWith('Arrow')) key = key.slice(5)
  if (key.length === 1 && /^[a-z0-9]$/i.test(key)) key = key.toUpperCase()
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
  const regularKey = (
    key === 'Space'
    || /^[A-Z0-9]$/.test(key)
    || ['Up', 'Down', 'Left', 'Right'].includes(key)
  )
  if (!functionKey && !regularKey) return ''
  const command = event.metaKey || event.ctrlKey
  if (!functionKey && !command && !event.altKey) return ''
  const shortcut = [
    command ? 'CommandOrControl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    key,
  ].filter(Boolean).join('+')
  if (['CommandOrControl+Q', 'CommandOrControl+W'].includes(shortcut)) {
    return ''
  }
  return shortcut
}

recordWakeShortcut.addEventListener('click', async () => {
  if (recordingWakeShortcut) {
    recordingWakeShortcut = false
    renderWakeShortcut()
    updateApplyState()
    await restoreWakeShortcutRegistration()
    return
  }
  try {
    await window.qwenAudioAgentDesktop.pauseWakeShortcut()
    recordingWakeShortcut = true
    recordWakeShortcut.blur()
    renderWakeShortcut()
    updateApplyState()
  } catch (error) {
    showMessage(friendlyError(error, '无法开始录制显示快捷键'), 'error')
  }
})

resetWakeShortcut.addEventListener('click', () => {
  const wasRecording = recordingWakeShortcut
  recordingWakeShortcut = false
  wakeShortcut.value = defaultWakeShortcut
  recordWakeShortcut.classList.remove('invalid')
  showMessage('')
  renderWakeShortcut()
  updateApplyState()
  if (wasRecording) void restoreWakeShortcutRegistration()
})

window.addEventListener('keydown', event => {
  if (!recordingWakeShortcut) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    recordingWakeShortcut = false
    renderWakeShortcut()
    updateApplyState()
    void restoreWakeShortcutRegistration()
    return
  }
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return
  const shortcut = capturedWakeShortcut(event)
  if (!shortcut) {
    showMessage('请使用 ⌘/Ctrl 或 Alt 组合键，也可以直接使用 F1–F24。', 'error')
    return
  }
  wakeShortcut.value = shortcut
  recordingWakeShortcut = false
  recordWakeShortcut.classList.remove('invalid')
  showMessage('')
  renderWakeShortcut()
  updateApplyState()
  void restoreWakeShortcutRegistration()
}, true)

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

let installingBackend = ''
let installProgressText = ''

function selectedBackend() {
  return backendList.querySelector('input[name="agent-protocol"]:checked')
    ?.value || 'none'
}

// 按本机检测结果重建后台 Agent 列表：每行 = 单选钮 + 名称 + 状态徽标
// + 安装按钮（仅“不可用且支持一键安装”时显示）；当前生效的值即使
// 不可用也保留可选，避免列表丢值。
function renderBackendOptions(currentValue) {
  const states = backendOptionStates(backendReport)
  const requestedValue = currentValue === 'acp' ? 'none' : currentValue
  if (requestedValue && !states.some(state => state.id === requestedValue)) {
    states.push({
      id: requestedValue,
      label: backendLabel(requestedValue),
      ready: false,
      selectable: true,
      installable: false,
      requiresConfirmation: false,
      authenticationRequired: false,
      authenticatable: false,
      reason: '当前不可用',
      title: '',
    })
  }
  const selected = requestedValue || 'none'
  backendList.replaceChildren(...states.map(state => {
    const row = document.createElement('label')
    row.className = 'backend-row'
    row.classList.toggle('selected', state.id === selected)
    row.classList.toggle('installing', installingBackend === state.id)
    row.classList.toggle(
      'unavailable',
      !state.ready && state.id !== 'none',
    )
    if (state.title) row.title = state.title

    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'agent-protocol'
    input.value = state.id
    input.checked = state.id === selected
    input.disabled = !state.selectable
    row.append(input)

    const name = document.createElement('span')
    name.className = 'backend-name'
    name.textContent = state.label
    row.append(name)

    const runtimeReady = backendRuntimeReady(state, {
      selectedBackend: settings?.agentProtocol,
      runtimeBackend: runtime?.backend,
    })
    if (installingBackend === state.id) {
      const progress = document.createElement('span')
      progress.className = 'backend-progress'
      progress.textContent = installProgressText || '正在安装…'
      progress.title = installProgressText
      row.append(progress)
    } else if (state.id !== 'none') {
      const status = document.createElement('span')
      status.className = `backend-status${
        runtimeReady
          ? ' ready'
          : state.authenticationRequired ? ' attention' : (
            state.ready ? ' installed' : ''
          )
      }`
      status.textContent = runtimeReady
        ? '已就绪'
        : state.statusLabel || state.reason
      row.append(status)
    }

    if (state.installable) {
      const button = document.createElement('button')
      button.className = 'backend-install'
      button.type = 'button'
      button.dataset.backend = state.id
      button.disabled = Boolean(installingBackend)
      button.textContent = '安装'
      button.title = state.requiresConfirmation
        ? '该后台需要通过官方脚本安装，执行前会再次确认'
        : '一键安装到本机'
      row.append(button)
    }
    if (state.authenticatable && !runtimeReady) {
      const button = document.createElement('button')
      button.className = 'backend-authenticate'
      button.type = 'button'
      button.dataset.backend = state.id
      button.disabled = Boolean(installingBackend)
      button.textContent = '登录'
      button.title = '在终端中打开该 Agent 的官方登录入口'
      row.append(button)
    }
    return row
  }))
}

// npm 缺失时的引导：错误文案 + Node.js 下载链接（经主进程 openExternal）。
function showNodejsInstallGuidance(text) {
  showMessage(
    text || '未找到 npm，请先安装 Node.js（自带 npm）后重试。',
    'error',
  )
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'message-link'
  link.textContent = '下载 Node.js ↗'
  link.addEventListener('click', () => {
    window.qwenAudioAgentDesktop.openExternal('https://nodejs.org/')
  })
  message.append(' ', link)
}

async function installBackendRow(id) {
  if (installingBackend) return
  installingBackend = id
  installProgressText = '正在安装…'
  showMessage('')
  renderBackendOptions(selectedBackend())
  try {
    const result = await window.qwenAudioAgentDesktop.installBackend(id)
    if (result?.report) backendReport = result.report
    if (!result?.ok) {
      // 用户在确认框取消属于正常操作，不提示；其余失败行内 + 消息条。
      if (result?.error?.code === 'NPM_MISSING') {
        showNodejsInstallGuidance(result.error.message)
      } else if (result?.error?.code !== 'DECLINED') {
        showMessage(result?.error?.message || '安装失败', 'error')
      }
      return
    }
    showMessage(
      result.authentication?.required
        ? `${backendLabel(id)} 已安装，请完成登录。`
        : result.alreadyInstalled
          ? `${backendLabel(id)} 已安装。`
          : `${backendLabel(id)} 安装成功。`,
      'success',
    )
  } catch (error) {
    showMessage(friendlyError(error, '安装失败'), 'error')
  } finally {
    installingBackend = ''
    installProgressText = ''
    renderBackendOptions(selectedBackend())
    updateApplyState()
  }
}

// 安装进度由主进程流式推送：行内只保留最近一行输出（截断显示）。
window.qwenAudioAgentDesktop.onBackendInstallProgress(progress => {
  if (!progress || progress.backend !== installingBackend) return
  if (progress.phase === 'start') {
    installProgressText = progress.title || '正在安装…'
  } else if (progress.phase === 'skip') {
    installProgressText = `${progress.title || '步骤'} 已就绪，跳过`
  } else if (progress.phase === 'output') {
    const line = String(progress.chunk || '')
      .split('\n')
      .map(part => part.trim())
      .filter(Boolean)
      .pop()
    if (line) installProgressText = truncate(line, 60)
  } else if (progress.phase === 'done') {
    installProgressText = `${progress.title || '步骤'} 完成`
  }
  const target = backendList.querySelector(
    '.backend-row.installing .backend-progress',
  )
  if (target) {
    target.textContent = installProgressText
    target.title = installProgressText
  }
})

backendList.addEventListener('change', event => {
  if (!event.target.matches('input[name="agent-protocol"]')) return
  showMessage('')
  for (const row of backendList.querySelectorAll('.backend-row')) {
    row.classList.toggle(
      'selected',
      row.querySelector('input')?.checked === true,
    )
  }
  updateApplyState()
})

// 安装按钮在 <label> 行内，必须阻止默认行为，避免触发行选中。
backendList.addEventListener('click', event => {
  const button = event.target.closest('.backend-install')
  if (button && !button.disabled) {
    event.preventDefault()
    void installBackendRow(button.dataset.backend)
    return
  }
  const authentication = event.target.closest('.backend-authenticate')
  if (!authentication || authentication.disabled) return
  event.preventDefault()
  window.qwenAudioAgentDesktop.authenticateBackend(authentication.dataset.backend)
    .then(() => showMessage(
      `已打开 ${backendLabel(authentication.dataset.backend)} 登录入口。`,
      'notice',
    ))
    .catch(error => showMessage(
      friendlyError(error, '无法打开登录入口'),
      'error',
    ))
})

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
    autoHideSeconds: Number(autoHideSeconds.value),
    wakeShortcut: wakeShortcut.value,
    wakeWordEnabled: wakeWordEnabled.checked,
    dashscopeApiKey: dashscopeApiKey.value,
    realtimeProvider: selectedRealtimeProvider(),
    agentProtocol: selectedBackend(),
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
    autoHideSeconds: value.autoHideSeconds,
    wakeShortcut: value.wakeShortcut,
    wakeWordEnabled: value.wakeWordEnabled,
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
  submit.disabled = (
    applying
    || recordingWakeShortcut
    || fingerprint(formSettings()) === appliedFingerprint
  )
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
    if (backendReport && !installingBackend) {
      renderBackendOptions(selectedBackend() || settings?.agentProtocol)
    }
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
    renderBackendOptions(selectedBackend() || settings?.agentProtocol)
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
  const hideValue = String(settings.autoHideSeconds ?? 120)
  autoHideSeconds.querySelector('[data-custom]')?.remove()
  if (![...autoHideSeconds.options].some(option => option.value === hideValue)) {
    const custom = document.createElement('option')
    custom.value = hideValue
    custom.dataset.custom = 'true'
    custom.textContent = `自定义 · ${hideValue} 秒`
    autoHideSeconds.append(custom)
  }
  autoHideSeconds.value = hideValue
  wakeShortcut.value = settings.wakeShortcut
  wakeWordEnabled.checked = settings.wakeWordEnabled || false
  recordingWakeShortcut = false
  renderWakeShortcut()
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
  autoHideSeconds,
  dashscopeApiKey,
  speechToSpeechRealtimeUrl,
  speechToSpeechAuthToken,
  realtimeModel,
  backendModel,
  ...realtimeProviderInputs,
  wakeWordEnabled,
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
    renderWakeShortcutStatus(result.wakeShortcutRegistered)
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
    if (
      String(error?.message || '').includes('快捷键')
      && String(error?.message || '').includes('占用')
    ) {
      renderWakeShortcutStatus(false)
    }
    showMessage(friendlyError(error, '应用失败'), 'error')
  } finally {
    applying = false
    updateApplyState()
  }
})

window.qwenAudioAgentDesktop.loadSettings().then(value => {
  settings = value.settings
  runtime = value.runtime
  renderWakeShortcutStatus(value.wakeShortcutRegistered)
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
