import {
  backendOptionStates,
  backendRuntimePhase,
  backendRuntimeReady,
} from './backend-options.mjs'
import {
  realtimeConnectionStatus,
  realtimeModelStatusLabel,
  realtimeStatusLabel,
} from './realtime-status.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  listDashScopeRealtimeModelProfiles,
} from '../../shared/realtime-model-catalog.mjs'
import { updaterButtonState, updaterStatusText } from './update-status.mjs'
import { createRealtimeVoiceDrafts } from './realtime-voice-settings.mjs'
import {
  desktopTranslator,
  effectiveDesktopLanguage,
  localizeDesktopDocument,
  localizeDesktopError,
} from './i18n.mjs'

const form = document.querySelector('#settings-form')
const gatewayUrl = document.querySelector('#gateway-url')
const orbSkinSelect = document.querySelector('#orb-style')
const importSkinButton = document.querySelector('#import-skin')
const removeSkinButton = document.querySelector('#remove-skin')
const autoHideSeconds = document.querySelector('#auto-hide-seconds')
const wakeShortcut = document.querySelector('#wake-shortcut')
const recordWakeShortcut = document.querySelector('#record-wake-shortcut')
const resetWakeShortcut = document.querySelector('#reset-wake-shortcut')
const wakeWordEnabled = document.querySelector('#wake-word-enabled')
const desktopLanguage = document.querySelector('#desktop-language')
const dashscopeApiKey = document.querySelector('#dashscope-api-key')
const realtimeBaseUrl = document.querySelector('#realtime-base-url')
const realtimeVoice = document.querySelector('#realtime-voice')
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
const backendPicker = document.querySelector('.backend-picker')
const backendPickerTrigger = document.querySelector('#backend-picker-trigger')
const backendPickerPopover = document.querySelector('#backend-picker-popover')
const backendPickerName = document.querySelector('#backend-picker-name')
const backendPickerStatus = document.querySelector('#backend-picker-status')
const backendPickerEmpty = document.querySelector('#backend-picker-empty')
const backendSearch = document.querySelector('#backend-search')
const refreshBackends = document.querySelector('#refresh-backends')
const realtimeModel = document.querySelector('#realtime-model')
const backendModel = document.querySelector('#backend-model')
const backendOwnership = document.querySelector('#backend-ownership')
const backendUrl = document.querySelector('#backend-url')
const backendCredential = document.querySelector('#backend-credential')
const backendConnectionRow = document.querySelector('.backend-connection-row')
const backendUrlRow = document.querySelector('.backend-url-row')
const backendCredentialRow = document.querySelector('.backend-credential-row')
const nodePathInput = document.querySelector('#node-path')
const applyNodePath = document.querySelector('#apply-node-path')
const nodePathRow = document.querySelector('.node-path-row')
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

let translate = desktopTranslator('auto', navigator.language)
const t = (text, params) => translate(text, params)

function applyLanguage(value) {
  translate = desktopTranslator(value, navigator.language)
  const effective = effectiveDesktopLanguage(value, navigator.language)
  localizeDesktopDocument(document, translate, effective)
  document.title = t('设置')
}

applyLanguage('auto')

let settings
let skins = []
let runtime
let backendReport = null
let pendingBackendConfiguration = ''
let appliedFingerprint = ''
let applying = false
let refreshingRuntime = false
let updaterState = null
let startupError = null
let recordingWakeShortcut = false
let realtimeVoiceDrafts = createRealtimeVoiceDrafts()
const defaultWakeShortcut = 'CommandOrControl+Shift+Space'
const defaultRealtimeBaseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const macPlatform = /Mac|iPhone|iPad/.test(navigator.platform)

function renderRealtimeModelOptions(selectedModel) {
  const profiles = listDashScopeRealtimeModelProfiles()
  const families = [
    ['omni', 'Qwen Omni'],
    ['audio', 'Qwen Audio'],
  ]
  const children = families.map(([family, label]) => {
    const group = document.createElement('optgroup')
    group.label = label
    for (const profile of profiles.filter(item => item.family === family)) {
      const option = document.createElement('option')
      option.value = profile.id
      option.textContent = profile.label
      group.append(option)
    }
    return group
  })
  const known = profiles.some(profile => profile.id === selectedModel)
  if (selectedModel && !known) {
    const custom = document.createElement('optgroup')
    custom.label = t('自定义')
    const option = document.createElement('option')
    option.value = selectedModel
    option.textContent = selectedModel
    custom.append(option)
    children.push(custom)
  }
  realtimeModel.replaceChildren(...children)
  realtimeModel.value = selectedModel || DEFAULT_DASHSCOPE_REALTIME_MODEL
}

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
    ? t('这个显示快捷键已被其他应用占用，点击重新设置')
    : t('点击后按下新的快捷键')
}

function wakeShortcutLabel(value) {
  const labels = {
    CommandOrControl: macPlatform ? 'Command' : 'Ctrl',
    Alt: macPlatform ? 'Option' : 'Alt',
    Shift: 'Shift',
    Space: 'Space',
    Up: 'Arrow Up',
    Down: 'Arrow Down',
    Left: 'Arrow Left',
    Right: 'Arrow Right',
  }
  return String(value || defaultWakeShortcut)
    .split('+')
    .map(part => labels[part] || part)
    .join(' + ')
}

function renderWakeShortcut() {
  recordWakeShortcut.textContent = recordingWakeShortcut
    ? t('请按快捷键…')
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
    showMessage(friendlyError(error, t('无法开始录制显示快捷键')), 'error')
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
    showMessage(t('请使用 Command/Ctrl 或 Alt 组合键，也可以直接使用 F1–F24。'), 'error')
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
  updaterStatus.textContent = localizeUpdaterStatus(status)
  updaterStatus.title = status.phase === 'error' ? status.message : ''
  const button = updaterButtonState(status)
  checkUpdates.textContent = t(button.label)
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
    showMessage(friendlyError(error, t('无法打开日志目录')), 'error')
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
  const text = String(error?.message || fallback).replace(
    /^Error invoking remote method '[^']+': Error:\s*/,
    '',
  )
  return localizeDesktopError(text, t)
}

function localizeUpdaterStatus(status) {
  if (effectiveDesktopLanguage(desktopLanguage?.value, navigator.language) !== 'en') {
    return updaterStatusText(status)
  }
  const version = status?.currentVersion || ''
  if (status?.phase === 'checking') return `${version} · Checking for updates…`
  if (status?.phase === 'downloading') {
    const percent = status.percent > 0 ? ` ${status.percent}%` : ''
    return `Version ${status.updateVersion} found, downloading${percent}…`
  }
  if (status?.phase === 'downloaded') return `Version ${status.updateVersion} is ready`
  if (status?.phase === 'current') return `${version} · Up to date`
  if (status?.phase === 'error') return `${version} · ${status.message || 'Update check failed'}`
  return version
}

function truncate(text, max = 80) {
  const value = String(text || '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

let installingBackend = ''
let pendingNodePathBackend = ''
let installProgressText = ''

function setBackendPickerOpen(open, { focus = false } = {}) {
  backendPickerPopover.hidden = !open
  backendPickerTrigger.setAttribute('aria-expanded', String(open))
  if (open && focus) {
    requestAnimationFrame(() => backendSearch.focus())
  }
}

function selectedBackend() {
  return backendList.querySelector('input[name="agent-protocol"]:checked')
    ?.value || 'none'
}

function renderBackendConnection() {
  const state = backendOptionStates(backendReport)
    .find(option => option.id === selectedBackend())
  const externalService = state?.externalService
  const supported = externalService?.supported === true
  backendConnectionRow.hidden = !supported
  if (!supported) backendOwnership.value = 'owned'
  const external = supported && backendOwnership.value === 'external'
  backendUrlRow.hidden = !external
  backendCredentialRow.hidden = !(
    external && externalService?.credential
  )
  if (externalService?.defaultBaseUrl) {
    backendUrl.placeholder = externalService.defaultBaseUrl
  }
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
      configurationRequired: false,
      configurable: false,
      reason: t('当前不可用'),
      title: '',
    })
  }
  const selected = requestedValue || 'none'
  const selectedState = states.find(state => state.id === selected) || states[0]
  const selectedRuntimeReady = selectedState && backendRuntimeReady(selectedState, {
    selectedBackend: settings?.agentProtocol,
    runtimeBackend: runtime?.backend,
  })
  backendPickerName.textContent = selectedState?.id === 'none'
    ? t('无后台 Agent')
    : selectedState?.label || backendLabel(selected)
  backendPickerName.title = backendPickerName.textContent
  backendPickerStatus.textContent = selectedState?.id === 'none'
    ? ''
    : selectedRuntimeReady
      ? t('已就绪')
      : t(selectedState?.statusLabel || selectedState?.reason || '')
  backendPickerStatus.title = backendPickerStatus.textContent
  backendPickerStatus.className = selectedRuntimeReady
    || selectedState?.configurationReady
    ? 'ready'
    : selectedState?.configurationRequired ? 'attention' : ''

  const query = backendSearch.value.trim().toLocaleLowerCase()
  const visibleStates = states.filter(state => {
    if (!query) return true
    return [state.label, state.id, state.statusLabel, state.reason]
      .some(value => String(value || '').toLocaleLowerCase().includes(query))
  })
  const standalone = visibleStates.filter(state => state.id === 'none')
  const installed = visibleStates.filter(state => state.id !== 'none' && state.ready)
  const available = visibleStates.filter(state => state.id !== 'none' && !state.ready)
  const children = []
  const appendGroup = (label, items) => {
    if (!items.length) return
    if (label) {
      const heading = document.createElement('div')
      heading.className = 'backend-group-label'
      heading.textContent = label
      children.push(heading)
    }
    children.push(...items.map(state => {
    const row = document.createElement('label')
    row.className = 'backend-row'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(state.id === selected))
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
    name.title = state.label
    row.append(name)

    const runtimeReady = backendRuntimeReady(state, {
      selectedBackend: settings?.agentProtocol,
      runtimeBackend: runtime?.backend,
    })
    if (installingBackend === state.id) {
      const progress = document.createElement('span')
      progress.className = 'backend-progress'
      progress.textContent = installProgressText || t('正在安装…')
      progress.title = progress.textContent
      row.append(progress)
    } else if (state.id !== 'none') {
      const status = document.createElement('span')
      status.className = `backend-status${
        runtimeReady || state.configurationReady
          ? ' ready'
          : state.configurationRequired ? ' attention' : (
            state.ready ? ' installed' : ''
          )
      }`
      status.textContent = runtimeReady
        ? t('已就绪')
        : t(state.statusLabel || state.reason)
      status.title = status.textContent
      row.append(status)
    }

    if (state.installable) {
      const button = document.createElement('button')
      button.className = 'backend-install'
      button.type = 'button'
      button.dataset.backend = state.id
      button.disabled = Boolean(installingBackend)
      button.textContent = t('安装')
      button.title = state.requiresConfirmation
        ? t('该后台需要通过官方脚本安装，执行前会再次确认')
        : t('一键安装到本机')
      row.append(button)
    }
    if (state.configurable && !runtimeReady) {
      const button = document.createElement('button')
      button.className = 'backend-configure'
      button.type = 'button'
      button.dataset.backend = state.id
      button.disabled = Boolean(installingBackend)
      button.textContent = t(state.configurationLabel || '配置')
      button.title = t(
        state.configurationHint || '打开该 Agent 自己提供的配置入口',
      )
      row.append(button)
    }
    return row
    }))
  }
  appendGroup('', standalone)
  appendGroup(t('已安装'), installed)
  appendGroup(t('可安装'), available)
  backendList.replaceChildren(...children)
  backendPickerEmpty.hidden = visibleStates.length > 0
  renderBackendConnection()
}

// npm 缺失时的引导：错误文案 + 指定路径入口 + Node.js 下载链接。
function showNodejsInstallGuidance(text, backendId) {
  showMessage(
    text || t('未找到 npm，请先安装 Node.js（自带 npm）后重试。'),
    'error',
  )
  // 记住是哪个后台 Agent 需要安装，路径确认后自动重试
  pendingNodePathBackend = backendId || ''
  // 指定路径入口
  if (nodePathRow && nodePathRow.hidden) {
    const specifyBtn = document.createElement('button')
    specifyBtn.type = 'button'
    specifyBtn.className = 'message-link'
    specifyBtn.textContent = t('指定 Node.js 路径')
    specifyBtn.addEventListener('click', () => {
      nodePathRow.hidden = false
      nodePathInput.focus()
    })
    message.append(' ', specifyBtn)
  }
  // 下载链接
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'message-link'
  link.textContent = t('下载 Node.js')
  link.addEventListener('click', () => {
    window.qwenAudioAgentDesktop.openExternal('https://nodejs.org/')
  })
  message.append(' ', link)
}

async function installBackendRow(id) {
  if (installingBackend) return
  installingBackend = id
  installProgressText = t('正在安装…')
  showMessage('')
  renderBackendOptions(selectedBackend())
  try {
    const result = await window.qwenAudioAgentDesktop.installBackend(id)
    if (result?.report) backendReport = result.report
    if (!result?.ok) {
      // 用户在确认框取消属于正常操作，不提示；其余失败行内 + 消息条。
      if (result?.error?.code === 'NPM_MISSING') {
        showNodejsInstallGuidance(result.error.message, id)
      } else if (result?.error?.code !== 'DECLINED') {
        showMessage(result?.error?.message || t('安装失败'), 'error')
      }
      return
    }
    showMessage(
      result.authentication?.required
        ? t('{backend} 已安装，请完成配置。', { backend: backendLabel(id) })
        : result.alreadyInstalled
          ? t('{backend} 已安装。', { backend: backendLabel(id) })
          : t('{backend} 安装成功。', { backend: backendLabel(id) }),
      'success',
    )
  } catch (error) {
    showMessage(friendlyError(error, t('安装失败')), 'error')
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
    installProgressText = progress.title || t('正在安装…')
  } else if (progress.phase === 'skip') {
    installProgressText = `${progress.title || t('步骤')} ${t('已就绪，跳过')}`
  } else if (progress.phase === 'output') {
    const line = String(progress.chunk || '')
      .split('\n')
      .map(part => part.trim())
      .filter(Boolean)
      .pop()
    if (line) installProgressText = truncate(line, 60)
  } else if (progress.phase === 'done') {
    installProgressText = `${progress.title || t('步骤')} ${t('完成')}`
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
  backendSearch.value = ''
  setBackendPickerOpen(false)
  renderBackendOptions(selectedBackend())
  backendPickerTrigger.focus()
  renderBackendConnection()
  updateApplyState()
})

backendPickerTrigger.addEventListener('click', () => {
  setBackendPickerOpen(backendPickerPopover.hidden, { focus: true })
})

backendPickerTrigger.addEventListener('keydown', event => {
  if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  setBackendPickerOpen(true, { focus: true })
})

backendSearch.addEventListener('input', () => {
  renderBackendOptions(selectedBackend())
})

backendSearch.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  setBackendPickerOpen(false)
  backendPickerTrigger.focus()
})

document.addEventListener('pointerdown', event => {
  if (!backendPickerPopover.hidden && !backendPicker.contains(event.target)) {
    setBackendPickerOpen(false)
  }
})

backendOwnership.addEventListener('change', () => {
  showMessage('')
  renderBackendConnection()
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
  const configuration = event.target.closest('.backend-configure')
  if (!configuration || configuration.disabled) return
  event.preventDefault()
  window.qwenAudioAgentDesktop.configureBackend(configuration.dataset.backend)
    .then(result => {
      // The backend owns its native configuration flow. We only remember that
      // it was opened and re-run the shared read-only probe when the user
      // returns; no backend credentials or completion callbacks cross layers.
      pendingBackendConfiguration = configuration.dataset.backend
      showMessage(
        result?.action?.hint
          ? t(result.action.hint)
          : t('已打开 {backend} 配置入口。', {
              backend: backendLabel(configuration.dataset.backend),
            }),
        'notice',
      )
    })
    .catch(error => showMessage(
      friendlyError(error, t('无法打开配置入口')),
      'error',
    ))
})

function backendLabel(value) {
  if (!value || value === 'none') return t('未配置')
  if (value === 'opencode') return 'OpenCode'
  if (value === 'openclaw') return 'OpenClaw'
  if (value === 'qoder') return 'Qoder'
  if (value === 'qwen') return 'Qwen Code'
  if (value === 'kimi') return 'Kimi Code'
  if (value === 'hermes') return 'Hermes'
  if (value === 'codebuddy') return 'CodeBuddy'
  if (value === 'codex') return 'Codex'
  if (value === 'claude') return 'Claude Code'
  if (value === 'deepseek') return 'DeepSeek'
  if (value === 'pi') return 'Pi'
  if (value === 'acp') return 'ACP Agent'
  return value
}

function selectedRealtimeProvider() {
  return realtimeProviderInputs.find(input => input.checked)?.value
    || 'dashscope'
}

function renderRealtimeVoice() {
  const voice = realtimeVoiceDrafts.selectModel(realtimeModel.value)
  realtimeVoice.value = voice.value
  realtimeVoice.placeholder = voice.placeholder
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
  if (populateDefault && provider === 'dashscope' && !realtimeBaseUrl.value.trim()) {
    realtimeBaseUrl.value = defaultRealtimeBaseUrl
  }
}

const BAILIAN_API_KEY_URL = 'https://bailian.console.aliyun.com/?tab=model#/api-key'

function formSettings() {
  return {
    gatewayUrl: gatewayUrl.value,
    orbSkin: orbSkinSelect.value,
    autoHideSeconds: Number(autoHideSeconds.value),
    wakeShortcut: wakeShortcut.value,
    wakeWordEnabled: wakeWordEnabled.checked,
    dashscopeApiKey: dashscopeApiKey.value,
    realtimeBaseUrl: realtimeBaseUrl.value,
    realtimeProvider: selectedRealtimeProvider(),
    agentProtocol: selectedBackend(),
    realtimeModel: realtimeModel.value,
    ...realtimeVoiceDrafts.settings(),
    speechToSpeechRealtimeUrl: speechToSpeechRealtimeUrl.value,
    speechToSpeechAuthToken: speechToSpeechAuthToken.value,
    backendModel: backendModel.value,
    backendOwnership: backendOwnership.value,
    backendUrl: backendUrl.value,
    backendCredential: backendCredential.value,
    nodePath: nodePathInput.value.trim(),
    language: desktopLanguage.value,
  }
}

function fingerprint(value) {
  return JSON.stringify({
    gatewayUrl: value.gatewayUrl,
    orbSkin: value.orbSkin,
    autoHideSeconds: value.autoHideSeconds,
    wakeShortcut: value.wakeShortcut,
    wakeWordEnabled: value.wakeWordEnabled,
    dashscopeApiKey: value.dashscopeApiKey,
    realtimeBaseUrl: value.realtimeBaseUrl,
    realtimeProvider: value.realtimeProvider,
    agentProtocol: value.agentProtocol,
    realtimeModel: value.realtimeModel,
    audioRealtimeVoice: value.audioRealtimeVoice,
    omniRealtimeVoice: value.omniRealtimeVoice,
    speechToSpeechRealtimeUrl: value.speechToSpeechRealtimeUrl,
    speechToSpeechAuthToken: value.speechToSpeechAuthToken,
    backendModel: value.backendModel,
    backendOwnership: value.backendOwnership,
    backendUrl: value.backendUrl,
    backendCredential: value.backendCredential,
    nodePath: value.nodePath,
    language: value.language,
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
  currentBackend.className = `connection-status ${
    connected === 'checking'
      ? 'checking'
      : connected ? 'connected' : 'disconnected'
  }`
}

function setRealtimeStatus(text, state) {
  currentRealtime.textContent = text
  currentRealtime.className = state === 'configured'
    ? ''
    : `connection-status ${state === 'connected' ? 'connected' : state === 'connecting' ? 'checking' : 'unavailable'}`
}

function renderRuntime() {
  if (!runtime?.gatewayConnected) {
    currentGateway.textContent = t('未连接')
    currentGateway.className = 'connection-status disconnected'
    setRealtimeStatus(t('Gateway 未连接'), 'disconnected')
    setBackendStatus(t('未连接'), false)
    return
  }

  currentGateway.textContent = t('已连接')
  currentGateway.className = 'connection-status connected'
  const realtimeLabel = realtimeStatusLabel(runtime.realtimeProvider)
  const realtimeModelLabel = realtimeModelStatusLabel(runtime.realtimeModel)
  if (!runtime.voiceConfigured) {
    setRealtimeStatus(`${realtimeLabel} · ${t('配置不完整')}`, 'disconnected')
  } else {
    const state = realtimeConnectionStatus(
      runtime.realtimeConnection?.byProvider?.[runtime.realtimeProvider],
    )
    const stateLabel = {
      connected: t('已连接'),
      connecting: t('正在连接'),
      unavailable: t('连接失败'),
      disconnected: t('连接异常'),
      configured: t('已配置'),
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
    setBackendStatus(t('未配置'), false)
    return
  }
  const label = runtime.backend.label
    || backendLabel(runtime.backend.protocol)
  const state = backendOptionStates(backendReport).find(option => (
    option.id === runtime.backend.protocol
  ))
  const phase = backendRuntimePhase(state, runtime.backend)
  if (phase === 'configuration-required') {
    setBackendStatus(`${label} · ${t('待配置')}`, false)
    currentBackend.title = state?.configurationHint || ''
    return
  }
  if (phase === 'starting') {
    setBackendStatus(`${label} · ${t('正在启动…')}`, 'checking')
    currentBackend.title = String(runtime.backend.error || '')
    return
  }
  if (phase === 'connection-failed') {
    const reason = String(runtime.backend.error).trim()
    setBackendStatus(t('{label} 未连接：{reason}', {
      label,
      reason: truncate(reason),
    }), false)
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
      showMessage(t('Gateway 已自动恢复。'), 'success')
    } else if (
      runtime.gatewayConnected
      && (!runtime.backend || runtime.backend.connected)
      && message.className === 'notice'
    ) {
      showMessage(t('配置已应用，Gateway 已启动。'), 'success')
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
    renderRuntime()
    updateApplyState()
    return backendReport
  } catch (error) {
    showMessage(friendlyError(error, t('检测后台 Agent 失败')), 'error')
    return null
  } finally {
    refreshBackends.disabled = false
  }
}

window.addEventListener('focus', () => {
  if (!pendingBackendConfiguration || installingBackend) return
  const id = pendingBackendConfiguration
  void detectBackendOptions(true).then(report => {
    if (!report) return
    const state = backendOptionStates(report)
      .find(option => option.id === id)
    if (!state?.configurationRequired) pendingBackendConfiguration = ''
  })
})

refreshBackends.addEventListener('click', () => {
  void detectBackendOptions(true)
})

function updateRemoveSkinState() {
  // 只有选中已导入的 sprite 皮肤时才可删除；内置外观不可。
  removeSkinButton.disabled = !skins.some(skin => (
    skin.type === 'sprite' && skin.id === orbSkinSelect.value
  ))
}

function renderSkinOptions(selected) {
  orbSkinSelect.textContent = ''
  const groups = [
    { label: t('内置'), type: 'theme' },
    { label: t('已导入皮肤'), type: 'sprite' },
  ]
  for (const group of groups) {
    const items = skins.filter(skin => skin.type === group.type)
    if (!items.length) continue
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.label
    for (const skin of items) {
      const option = document.createElement('option')
      option.value = skin.id
      option.textContent = skin.displayName || skin.id
      optgroup.append(option)
    }
    orbSkinSelect.append(optgroup)
  }
  // 皮肤包被手动删除后配置仍可能指向它：保留选项让用户看到现状。
  if (selected && !skins.some(skin => skin.id === selected)) {
    const missing = document.createElement('option')
    missing.value = selected
    missing.textContent = `${selected}${t('（缺失）')}`
    orbSkinSelect.append(missing)
  }
  orbSkinSelect.value = selected || 'fluid'
  updateRemoveSkinState()
}

function render() {
  gatewayUrl.value = settings.gatewayUrl
  renderSkinOptions(settings.orbSkin)
  const hideValue = String(settings.autoHideSeconds ?? 120)
  autoHideSeconds.querySelector('[data-custom]')?.remove()
  if (![...autoHideSeconds.options].some(option => option.value === hideValue)) {
    const custom = document.createElement('option')
    custom.value = hideValue
    custom.dataset.custom = 'true'
    custom.textContent = effectiveDesktopLanguage(desktopLanguage.value, navigator.language) === 'en'
      ? `Custom · ${hideValue} seconds`
      : `自定义 · ${hideValue} 秒`
    autoHideSeconds.append(custom)
  }
  autoHideSeconds.value = hideValue
  wakeShortcut.value = settings.wakeShortcut
  wakeWordEnabled.checked = settings.wakeWordEnabled || false
  desktopLanguage.value = settings.language || 'auto'
  applyLanguage(desktopLanguage.value)
  recordingWakeShortcut = false
  renderWakeShortcut()
  dashscopeApiKey.value = settings.dashscopeApiKey || ''
  realtimeBaseUrl.value = settings.realtimeBaseUrl || defaultRealtimeBaseUrl
  renderBackendOptions(settings.agentProtocol || 'none')
  renderRealtimeModelOptions(
    settings.realtimeModel || DEFAULT_DASHSCOPE_REALTIME_MODEL,
  )
  realtimeVoiceDrafts = createRealtimeVoiceDrafts(settings)
  renderRealtimeVoice()
  speechToSpeechRealtimeUrl.value = settings.speechToSpeechRealtimeUrl || ''
  speechToSpeechAuthToken.value = settings.speechToSpeechAuthToken || ''
  renderRealtimeProvider(settings.realtimeProvider)
  backendModel.value = settings.backendModel || ''
  backendOwnership.value = settings.backendOwnership || 'owned'
  backendUrl.value = settings.backendUrl || ''
  backendCredential.value = settings.backendCredential || ''
  renderBackendConnection()
  nodePathInput.value = settings.nodePath || ''
  renderRuntime()
  appliedFingerprint = fingerprint(formSettings())
  updateApplyState()
}

for (const control of [
  gatewayUrl,
  orbSkinSelect,
  autoHideSeconds,
  dashscopeApiKey,
  realtimeBaseUrl,
  speechToSpeechRealtimeUrl,
  speechToSpeechAuthToken,
  realtimeModel,
  realtimeVoice,
  backendModel,
  backendUrl,
  backendCredential,
  nodePathInput,
  ...realtimeProviderInputs,
  wakeWordEnabled,
  desktopLanguage,
]) {
  control.addEventListener('input', () => {
    showMessage('')
    if (control === realtimeVoice) realtimeVoiceDrafts.update(realtimeVoice.value)
    updateApplyState()
  })
  control.addEventListener('change', () => {
    showMessage('')
    if (realtimeProviderInputs.includes(control)) {
      renderRealtimeProvider(control.value, { populateDefault: true })
    }
    if (control === realtimeModel) {
      renderRealtimeVoice()
    }
    if (control === desktopLanguage) {
      applyLanguage(control.value)
      renderWakeShortcut()
      renderUpdater(updaterState)
      renderBackendOptions(selectedBackend())
      renderSkinOptions(orbSkinSelect.value)
      renderRealtimeModelOptions(realtimeModel.value)
      renderRuntime()
    }
    updateApplyState()
  })
}

getApiKey.addEventListener('click', () => {
  window.qwenAudioAgentDesktop.openExternal(BAILIAN_API_KEY_URL)
})

orbSkinSelect.addEventListener('change', updateRemoveSkinState)

importSkinButton.addEventListener('click', async () => {
  importSkinButton.disabled = true
  try {
    const imported = await window.qwenAudioAgentDesktop.importSkin()
    if (!imported) return
    skins = [
      ...skins.filter(skin => skin.id !== imported.id),
      { id: imported.id, type: 'sprite', displayName: imported.displayName },
    ]
    renderSkinOptions(imported.id)
    showMessage(t('已导入皮肤 {skin}，点击应用后生效。', {
      skin: imported.displayName,
    }), 'notice')
    updateApplyState()
  } catch (error) {
    showMessage(friendlyError(error, t('导入皮肤失败')), 'error')
  } finally {
    importSkinButton.disabled = false
    updateRemoveSkinState()
  }
})

removeSkinButton.addEventListener('click', async () => {
  const id = orbSkinSelect.value
  const skin = skins.find(item => item.type === 'sprite' && item.id === id)
  if (!skin) return
  removeSkinButton.disabled = true
  try {
    await window.qwenAudioAgentDesktop.removeSkin(id)
    skins = skins.filter(item => item.id !== id)
    // 删掉的可能正是当前皮肤：回到内置外观，由用户点应用持久化。
    renderSkinOptions('fluid')
    showMessage(t('已删除皮肤 {skin}，点击应用后生效。', {
      skin: skin.displayName,
    }), 'notice')
    updateApplyState()
  } catch (error) {
    showMessage(friendlyError(error, t('删除皮肤失败')), 'error')
  } finally {
    updateRemoveSkinState()
  }
})

// "确认"按钮：保存自定义 Node.js 路径后立即重检并重试安装
applyNodePath.addEventListener('click', async () => {
  const path = nodePathInput.value.trim()
  if (!path) {
    showMessage(t('请填写 Node.js 安装目录'), 'error')
    return
  }
  applyNodePath.disabled = true
  showMessage(t('正在保存路径…'))
  const retryId = pendingNodePathBackend
  pendingNodePathBackend = ''
  try {
    await window.qwenAudioAgentDesktop.setNodePath(path)
    nodePathRow.hidden = true
    showMessage(t('路径已保存，正在重新检测…'))
    await detectBackendOptions(true)
    // 自动重试之前失败的安装
    if (retryId) {
      showMessage(t('正在重新安装 {backend}…', {
        backend: backendLabel(retryId),
      }))
      await installBackendRow(retryId)
    }
  } catch (err) {
    showMessage(
      err?.message || t('保存失败，请重试'),
      'error',
    )
  } finally {
    applyNodePath.disabled = false
  }
})

form.addEventListener('submit', async event => {
  event.preventDefault()
  applying = true
  updateApplyState()
  showMessage(t('正在应用…'))
  try {
    const result = await window.qwenAudioAgentDesktop.saveSettings(formSettings())
    settings = result.settings
    runtime = result.runtime
    renderWakeShortcutStatus(result.wakeShortcutRegistered)
    render()
    if (!runtime.gatewayConnected) {
      showMessage(t('配置已保存，Gateway 正在启动…'), 'notice')
    } else if (runtime.backend && !runtime.backend.connected) {
      showMessage(t('Gateway 已启动，后台 Agent 正在连接…'), 'notice')
    } else {
      showMessage(
        t(result.restarted ? '已应用，Gateway 已启动。' : '已应用。'),
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
    showMessage(friendlyError(error, t('应用失败')), 'error')
  } finally {
    applying = false
    updateApplyState()
  }
})

window.qwenAudioAgentDesktop.loadSettings().then(value => {
  settings = value.settings
  skins = value.skins || []
  runtime = value.runtime
  renderWakeShortcutStatus(value.wakeShortcutRegistered)
  render()
  void detectBackendOptions()
  if (value.runtimeError) {
    startupError = value.runtimeError
    showMessage(t('当前配置启动失败：{error}', {
      error: localizeDesktopError(value.runtimeError, t),
    }), 'error')
  } else if (value.setupRequired) {
    showMessage(t('首次使用，请配置语音引擎并选择后台 Agent。'), 'notice')
  }
}).catch(error => {
  showMessage(friendlyError(error, t('读取设置失败')), 'error')
  submit.disabled = true
})

setInterval(() => {
  void refreshRuntime()
}, 2000)
