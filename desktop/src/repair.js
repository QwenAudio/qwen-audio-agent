import {
  requiresOrbHandoffRetry,
  runtimePresentation,
} from './runtime-presentation.mjs'

const api = window.qwenAudioAgentDesktop
const runtimeSummary = document.querySelector('#runtime-summary')
const runtimeTitle = document.querySelector('#runtime-title')
const runtimeActionText = document.querySelector('#runtime-action-text')
const distributionSummary = document.querySelector('#distribution-summary')
const modeInputs = [...document.querySelectorAll('input[name="runtime-mode"]')]
const distributionRow = document.querySelector('#distribution-row')
const distributionSelect = document.querySelector('#wsl-distribution')
const externalOriginRow = document.querySelector('#external-origin-row')
const externalOrigin = document.querySelector('#external-gateway-origin')
const connectExternal = document.querySelector('#connect-external')
const runtimeChecks = document.querySelector('#runtime-checks')
const progressSection = document.querySelector('#progress-section')
const progressLabel = document.querySelector('#progress-label')
const progressValue = document.querySelector('#progress-value')
const runtimeProgress = document.querySelector('#runtime-progress')
const installConfirmation = document.querySelector('#install-confirmation')
const installCommand = document.querySelector('#install-command')
const confirmInstall = document.querySelector('#confirm-install')
const restartRuntime = document.querySelector('#restart-runtime')
const copyDiagnostics = document.querySelector('#copy-diagnostics')
const prepareRemoval = document.querySelector('#prepare-removal')
const removalConfirmation = document.querySelector('#removal-confirmation')
const removalTarget = document.querySelector('#removal-target')
const confirmRemoval = document.querySelector('#confirm-removal')
const microphoneSettings = document.querySelector('#microphone-settings')
const primaryAction = document.querySelector('#primary-action')
const operationMessage = document.querySelector('#operation-message')

const SUPPORT_ACTIONS = Object.freeze({
  'open-wsl-install': 'wsl-install',
  'open-node-download': 'node-download',
  'open-wsl-networking': 'wsl-networking',
})

let context = null
let status = { state: 'checking', reason: null, environment: {} }
let presentation = null
let installPlan = null
let removalPlan = null
let busy = false
let draftMode = null
let orbHandoffFailed = false

function setMessage(text, kind = '') {
  operationMessage.textContent = text
  operationMessage.className = kind
}

function selectedMode() {
  return modeInputs.find(input => input.checked)?.value || 'managed'
}

function setBusy(value) {
  busy = value
  render()
}

function replaceDistributionOptions() {
  const currentNames = [...distributionSelect.options].map(option => option.value)
  const nextNames = ['', ...(context?.distributions || [])]
  if (JSON.stringify(currentNames) === JSON.stringify(nextNames)) return
  const options = nextNames.map((name, index) => {
    const option = document.createElement('option')
    option.value = name
    option.textContent = index === 0 ? '自动选择' : name
    return option
  })
  distributionSelect.replaceChildren(...options)
}

function renderChecks(checks) {
  runtimeChecks.replaceChildren(...checks.map(item => {
    const row = document.createElement('li')
    row.className = item.state
    const dot = document.createElement('span')
    dot.className = 'check-dot'
    dot.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'check-label'
    label.textContent = item.label
    const value = document.createElement('span')
    value.className = 'check-value'
    value.textContent = item.value
    row.append(dot, label, value)
    return row
  }))
}

function render() {
  presentation = runtimePresentation({
    status,
    environment: status.environment || {},
    installPlan,
    orbHandoffFailed,
  })
  runtimeSummary.className = `summary ${presentation.tone}`
  runtimeTitle.textContent = presentation.title
  runtimeActionText.textContent = presentation.actionText
  distributionSummary.textContent = status.environment?.distribution
    ? `WSL - ${status.environment.distribution}`
    : '正在检查 WSL'

  const mode = draftMode || context?.runtimeMode || 'managed'
  for (const input of modeInputs) {
    input.checked = input.value === mode
    input.disabled = busy
  }
  replaceDistributionOptions()
  distributionSelect.value = context?.distribution || ''
  distributionSelect.disabled = busy || mode !== 'managed'
  distributionRow.hidden = mode !== 'managed'
  externalOriginRow.hidden = mode !== 'external'
  if (!externalOrigin.value && status.environment?.externalGatewayOrigin) {
    externalOrigin.value = status.environment.externalGatewayOrigin
  }
  externalOrigin.disabled = busy
  connectExternal.disabled = busy || !externalOrigin.value.trim()

  renderChecks(presentation.checks)
  progressSection.hidden = !presentation.progress.visible
  progressLabel.textContent = presentation.progress.label
  progressValue.textContent = `${presentation.progress.value}%`
  runtimeProgress.value = presentation.progress.value

  installConfirmation.hidden = !presentation.showCommandConfirmation
  installCommand.textContent = presentation.showCommandConfirmation
    ? installPlan.displayCommand
    : ''
  confirmInstall.disabled = busy

  const managedActive = context?.runtimeMode === 'managed'
    && ['starting', 'ready', 'recovering'].includes(status.state)
  restartRuntime.disabled = busy || status.state === 'setup-required'
  copyDiagnostics.disabled = busy
  prepareRemoval.disabled = busy
    || managedActive
    || !status.environment?.runtimeVersion
  confirmRemoval.disabled = busy
  removalConfirmation.hidden = !removalPlan
  removalTarget.textContent = removalPlan?.root || ''

  microphoneSettings.hidden = !presentation.offerMicrophoneSettings
  microphoneSettings.disabled = busy
  const label = presentation.showCommandConfirmation
    && presentation.primaryAction === 'prepare-install'
    ? ''
    : presentation.primaryLabel
  primaryAction.hidden = !label
  primaryAction.textContent = label || '重新检查'
  primaryAction.disabled = busy
}

async function refresh() {
  const [nextContext, nextStatus] = await Promise.all([
    api.getDesktopContext(),
    api.getRuntimeStatus(),
  ])
  context = nextContext
  status = nextStatus
  if (context.runtimeMode !== 'external') draftMode = null
  render()
}

async function runOperation(operation, successText = '') {
  setMessage('正在处理…')
  setBusy(true)
  try {
    const result = await operation()
    await refresh()
    const message = typeof successText === 'function'
      ? successText(result)
      : successText
    setMessage(message, message ? 'success' : '')
  } catch {
    setMessage('操作未完成，请检查状态后重试。', 'error')
  } finally {
    setBusy(false)
  }
}

primaryAction.addEventListener('click', () => {
  const action = presentation.primaryAction
  if (action === 'open-orb') {
    void runOperation(async () => {
      await api.openWindowsOrb()
      orbHandoffFailed = false
    })
    return
  }
  if (action === 'retry') {
    void runOperation(() => api.retryRuntime())
    return
  }
  if (action === 'prepare-install') {
    void runOperation(async () => {
      installPlan = await api.getRuntimeInstallPlan()
    })
    return
  }
  if (action === 'open-microphone-settings') {
    void api.openWindowsMicrophoneSettings()
    return
  }
  const supportId = SUPPORT_ACTIONS[action]
  if (supportId) void api.openWindowsSupportLink(supportId)
})

confirmInstall.addEventListener('click', () => {
  if (!installPlan) return
  const confirmationId = installPlan.confirmationId
  void runOperation(async () => {
    const result = await api.confirmRuntimeInstall(confirmationId)
    installPlan = null
    orbHandoffFailed = requiresOrbHandoffRetry(result)
  }, '运行环境已安装。')
})

for (const input of modeInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return
    installPlan = null
    removalPlan = null
    if (input.value === 'external') {
      draftMode = 'external'
      render()
      externalOrigin.focus()
      return
    }
    draftMode = null
    void runOperation(() => api.setRuntimeMode('managed'))
  })
}

distributionSelect.addEventListener('change', () => {
  installPlan = null
  removalPlan = null
  void runOperation(() => api.setWslDistribution(distributionSelect.value))
})

externalOrigin.addEventListener('input', render)
connectExternal.addEventListener('click', () => {
  const origin = externalOrigin.value.trim()
  void runOperation(async () => {
    await api.setExternalGatewayOrigin(origin)
    await api.setRuntimeMode('external')
    draftMode = null
  })
})

restartRuntime.addEventListener('click', () => {
  void runOperation(() => api.restartRuntime(), '运行环境已重新启动。')
})

copyDiagnostics.addEventListener('click', () => {
  void runOperation(
    () => api.copyRuntimeDiagnostics(),
    result => `已复制 ${result.lineCount} 行日志。`,
  )
})

prepareRemoval.addEventListener('click', () => {
  void runOperation(async () => {
    removalPlan = await api.getPrivateRuntimeRemovalPlan()
  })
})

confirmRemoval.addEventListener('click', () => {
  if (!removalPlan) return
  const confirmationId = removalPlan.confirmationId
  void runOperation(async () => {
    await api.confirmPrivateRuntimeRemoval(confirmationId)
    removalPlan = null
  }, '专用运行环境已移除。')
})

microphoneSettings.addEventListener('click', () => {
  void api.openWindowsMicrophoneSettings()
})

api.subscribeRuntimeStatus(nextStatus => {
  status = {
    ...status,
    ...nextStatus,
    health: nextStatus.health || status.health,
    environment: nextStatus.environment || status.environment,
  }
  render()
})

refresh().catch(() => {
  status = { state: 'error', reason: null, environment: {} }
  setMessage('无法读取运行状态，请稍后重试。', 'error')
  render()
})

setInterval(() => {
  if (!busy) void refresh().catch(() => {})
}, 2000)
