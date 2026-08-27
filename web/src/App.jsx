import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  buildConversationTurns,
  discardUserTranscript,
  mergeConversationHistory,
  upsertAssistantTranscript,
  upsertUserTranscript,
} from './message-order.js'
import MessageContent from './MessageContent.jsx'
import MultimodalComposer from './MultimodalComposer.jsx'
import DesktopFluidOrb from './DesktopFluidOrb.jsx'
import DesktopSpriteOrb from './DesktopSpriteOrb.jsx'
import { desktopOrbClassName, resolveOrbVisualState } from './orb-presentation.js'
import {
  isBuiltinOrbSkin,
  resolveOrbSkinId,
} from '../../shared/orb-skin-catalog.mjs'
import { supportsComposerInput } from '../../shared/client-input-capabilities.mjs'
import { resultLabel } from './presentation.js'
import { t } from './i18n.js'
import {
  removeDeliveredTask,
  removeTaskInPhase,
  taskDeliverySettled,
  taskDetail,
  taskNeedsPresentation,
  taskLabel,
  taskView,
} from './task-view.js'
import useRealtimeVoice, {
  realtimeModelStatus,
  realtimeProviderForConnection,
  realtimeProviderSelection,
  shouldClaimReleasedVoice,
} from './useRealtimeVoice.js'
import { requestedSessionId } from './session.js'
import { initialVoiceEnabled } from './voice-defaults.js'
import {
  applyDesktopClientState,
  desktopAutoHideSeconds,
  desktopCanHide,
  desktopHideDeadline,
  desktopWakeWordEnabled,
  desktopWorkSettled,
  desktopTasksWorking,
} from './desktop-hide.js'
import {
  desktopTaskCards,
} from './desktop-task-cards.js'
import {
  advanceDesktopRuntimePresentation,
  desktopBackendRuntime,
  desktopRealtimeRuntime,
  resolveDesktopRuntime,
} from './desktop-runtime.js'
import {
  spriteAnimationEventForGatewayEvent,
  spriteAnimationForEvent,
} from './sprite-orb.js'

const desktopOrbMode = (
  new URLSearchParams(window.location.search).get('desktop') === 'orb'
)
const initialDesktopSurfaceMode = (
  new URLSearchParams(window.location.search).get('surface') === 'panel'
    ? 'panel'
    : 'orb'
)
const takeoverRequested = (
  new URLSearchParams(window.location.search).get('takeover') === '1'
)
const orbSkinId = resolveOrbSkinId({
  orbSkin: new URLSearchParams(window.location.search).get('orbSkin'),
  orbStyle: new URLSearchParams(window.location.search).get('orbStyle'),
})
const autoHideSeconds = desktopAutoHideSeconds(window.location.search)
const wakeWordEnabled = desktopWakeWordEnabled(window.location.search)
const composerEnabled = supportsComposerInput(desktopOrbMode ? 'desktop' : 'web')

function getSessionId() {
  const requested = requestedSessionId(window.location.search)
  if (requested) {
    localStorage.setItem('qwen-audio-agent.session', requested)
    return requested
  }
  const current = localStorage.getItem('qwen-audio-agent.session')
  if (current) return current
  const created = crypto.randomUUID()
  localStorage.setItem('qwen-audio-agent.session', created)
  return created
}

function labelFor(state) {
  return {
    idle: t('待命'),
    listening: t('正在听'),
    processing: t('正在处理'),
    speaking: t('正在说'),
    working: t('正在处理任务'),
    starting: t('正在启动'),
    connecting: t('正在连接语音前台'),
    occupied: t('其他入口正在使用'),
    hidden: t('已隐藏'),
    waking: t('正在显示'),
  }[state] || state
}

function frontendLabel(holder) {
  return holder?.label || {
    desktop: t('桌面端'),
    cli: t('终端'),
    web: 'WebUI',
  }[holder?.type] || t('其他入口')
}

function OrbControlIcon({ type, muted = false, collapsed = false }) {
  if (type === 'microphone') {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3m-3 0h6" />
      {muted && <path d="M4 4 20 20" />}
    </svg>
  }
  if (type === 'settings') {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2 2 0 0 1-2.83 2.83l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.08 1.65V21a2 2 0 0 1-4 0v-.06A1.8 1.8 0 0 0 8.8 19.3a1.8 1.8 0 0 0-1.98.36l-.04.04a2 2 0 0 1-2.83-2.83l.04-.04a1.8 1.8 0 0 0 .36-1.98A1.8 1.8 0 0 0 2.7 13.8H2.6a2 2 0 0 1 0-4h.06A1.8 1.8 0 0 0 4.3 8.72a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2 2 0 0 1 2.83-2.83l.04.04a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 9.82 2.6V2.5a2 2 0 0 1 4 0v.06A1.8 1.8 0 0 0 14.9 4.2a1.8 1.8 0 0 0 1.98-.36l.04-.04a2 2 0 0 1 2.83 2.83l-.04.04a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.08h.1a2 2 0 0 1 0 4h-.06A1.8 1.8 0 0 0 19.4 15Z" />
    </svg>
  }
  if (type === 'conversation') {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5.5h14v10H9l-4 3v-13Z" />
      <path d="M8 9h8m-8 3h5" />
    </svg>
  }
  if (type === 'collapse') {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 10 4 4 4-4" />
    </svg>
  }
  if (type === 'tasks') {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={collapsed ? 'm7 9 5 5 5-5' : 'm7 14 5-5 5 5'} />
    </svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m7 7 10 10M17 7 7 17" />
  </svg>
}

function upsertTask(items, taskId, update, fallback) {
  const index = items.findIndex(item => item.id === taskId)
  if (index < 0) return fallback ? [...items, fallback] : items
  const next = [...items]
  next[index] = update(next[index])
  return next
}

export default function App() {
  const [sessionId, setSessionId] = useState(getSessionId)
  const [voiceEnabled, setVoiceEnabled] = useState(() => initialVoiceEnabled({
    desktopOrbMode,
  }))
  const [waitingForVoice, setWaitingForVoice] = useState(false)
  const [messages, setMessages] = useState([])
  const [activity, setActivity] = useState(t('正在检查后台 Agent'))
  const [frontend, setFrontend] = useState({ label: 'Realtime Agent' })
  const [realtimeProviders, setRealtimeProviders] = useState([])
  const [realtimeProvider, setRealtimeProvider] = useState(
    () => localStorage.getItem('qwen-audio-agent.realtimeProvider') || '',
  )
  const [modelStatus, setModelStatus] = useState(() => realtimeModelStatus())
  const [providerNotice, setProviderNotice] = useState('')
  const [healthValidated, setHealthValidated] = useState(false)
  const [gatewayRuntime, setGatewayRuntime] = useState('connecting')
  const [backend, setBackend] = useState({
    label: 'Agent',
    enabled: null,
    ready: false,
    status: 'starting',
    code: null,
  })
  const [agentTasks, setAgentTasks] = useState([])
  const [desktopTasksCollapsed, setDesktopTasksCollapsed] = useState(false)
  const [desktopTaskLayout, setDesktopTaskLayout] = useState({
    placement: 'below',
    orbOffsetX: 0,
  })
  const [orbDragging, setOrbDragging] = useState(false)
  const [orbDragDirection, setOrbDragDirection] = useState('')
  const [spriteAnimationCues, setSpriteAnimationCues] = useState([])
  const [spriteOrbFailed, setSpriteOrbFailed] = useState(false)
  const [desktopLifecycle, setDesktopLifecycle] = useState('active')
  const [desktopSurfaceMode, setDesktopSurfaceMode] = useState(
    initialDesktopSurfaceMode,
  )
  const [lastInteractionAt, setLastInteractionAt] = useState(Date.now)
  const [workSettledAt, setWorkSettledAt] = useState(Date.now)
  const activeVoiceResponse = useRef('')
  const currentTurnId = useRef('')
  const responseTurnMap = useRef(new Map())
  const agentTurnIds = useRef(new Set())
  const taskDismissTimers = useRef(new Map())
  const messagesRef = useRef(null)
  const stickToBottom = useRef(true)
  const orbDrag = useRef(null)
  const spriteAnimationCueId = useRef(0)
  const runtimeReadyAnnounced = useRef(false)
  const previousWorkSettled = useRef(true)
  const workSettledAtRef = useRef(workSettledAt)
  const lastWakeAtRef = useRef(0)
  const previousDesktopLifecycle = useRef('active')
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const spriteAnimationCue = spriteAnimationCues[0] || null

  useEffect(() => {
    const persistSession = window.qwenAudioAgentDesktop?.setConversationSession
    if (!desktopOrbMode || typeof persistSession !== 'function') return
    void persistSession(sessionId).catch(() => {})
  }, [sessionId])

  const noteInteraction = useCallback(() => {
    setLastInteractionAt(Date.now())
  }, [])

  const changeDesktopSurface = useCallback(async mode => {
    const bridge = window.qwenAudioAgentDesktop
    if (!desktopOrbMode || !bridge?.setSurface) return
    try {
      const result = await bridge.setSurface(mode)
      setDesktopSurfaceMode(result?.mode === 'panel' ? 'panel' : 'orb')
      noteInteraction()
    } catch {
      // A rejected host transition leaves the current presentation intact.
    }
  }, [noteInteraction])

  const triggerSpriteAnimation = useCallback((eventName, { priority = false } = {}) => {
    if (!desktopOrbMode || isBuiltinOrbSkin(orbSkinId)) return
    const name = spriteAnimationForEvent(eventName)
    if (!name) return
    spriteAnimationCueId.current += 1
    const cue = { id: spriteAnimationCueId.current, name }
    setSpriteAnimationCues(current => (
      priority ? [cue, ...current] : [...current, cue]
    ))
  }, [])

  const completeSpriteAnimationCue = useCallback(id => {
    setSpriteAnimationCues(current => (
      current[0]?.id === id ? current.slice(1) : current
    ))
  }, [])

  const respondToPermission = useCallback(async (taskId, permission, decision) => {
    if (!permission?.id || permission.submitting) return
    setAgentTasks(items => upsertTask(
      items,
      taskId,
      task => ({
        ...task,
        authorization: {
          ...task.authorization,
          submitting: true,
          error: null,
        },
      }),
    ))
    try {
      const response = await fetch(
        `api/permissions/${encodeURIComponent(permission.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      )
      if (response.status === 404 || response.status === 409) {
        setAgentTasks(items => upsertTask(
          items,
          taskId,
          task => ({ ...task, authorization: null }),
        ))
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || t('请求失败（{status}）', { status: response.status }))
      }
    } catch (error) {
      setAgentTasks(items => upsertTask(
        items,
        taskId,
        task => ({
          ...task,
          authorization: task.authorization
            ? {
                ...task.authorization,
                submitting: false,
                error: t('没有提交成功：{message}', { message: error.message }),
              }
            : null,
        }),
      ))
    }
  }, [])

  useLayoutEffect(() => {
    const container = messagesRef.current
    if (container && stickToBottom.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages, agentTasks])

  useEffect(() => () => {
    taskDismissTimers.current.forEach(timer => clearTimeout(timer))
    taskDismissTimers.current.clear()
  }, [])

  useEffect(() => {
    let cancelled = false
    let refreshTimer
    const refresh = () => fetch('api/health', { cache: 'no-store' })
      .then(async response => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (cancelled) return
        const gatewayReady = response.ok && payload.ok !== false
        const backendPayload = payload.backend || {}
        const backendEnabled = backendPayload.enabled !== false && Boolean(
          backendPayload.kind || backendPayload.protocol,
        )
        const label = payload.backend?.label || payload.backend?.kind || 'Agent'
        setFrontend({
          label: payload.realtimeLabel || payload.realtimeProvider || 'Realtime Agent',
        })
        setRealtimeProviders(payload.realtimeProviders || [])
        setModelStatus(realtimeModelStatus(payload))
        // A front end persisted by an earlier visit may no longer exist on this
        // server (removed provider, different deployment). Sending it would be
        // refused on every connect, so the stale selection is dropped in favour
        // of the server default instead of leaving the client stuck.
        setRealtimeProvider(current => {
          const selection = realtimeProviderSelection(current, payload)
          setProviderNotice(selection.notice)
          if (selection.provider !== current) {
            localStorage.removeItem('qwen-audio-agent.realtimeProvider')
          }
          return selection.provider
        })
        setGatewayRuntime(gatewayReady ? 'ready' : 'failed')
        setHealthValidated(gatewayReady)
        setBackend({
          label,
          enabled: backendEnabled,
          ready: gatewayReady && (
            backendEnabled ? backendPayload.ok === true : true
          ),
          status: backendPayload.status || (
            backendEnabled ? 'starting' : 'not_configured'
          ),
          code: backendPayload.code || null,
          error: backendPayload.error || '',
          url: payload.backend?.uiPath || payload.backend?.baseUrl || '',
        })
        setActivity(response.ok ? t('Gateway 已连接') : t('能力服务尚未连接'))
        if (desktopOrbMode) {
          const backendSettled = !backendEnabled || [
            'ready',
            'failed',
          ].includes(backendPayload.status)
          refreshTimer = setTimeout(refresh, backendSettled ? 3000 : 500)
        }
      })
      .catch(() => {
        if (cancelled) return
        setGatewayRuntime('failed')
        setHealthValidated(false)
        setActivity(t('qwen-audio-agent Gateway 尚未连接'))
        if (desktopOrbMode) refreshTimer = setTimeout(refresh, 1000)
      })
    refresh()
    return () => {
      cancelled = true
      clearTimeout(refreshTimer)
    }
  }, [])

  const updateUserTranscript = useCallback((event, final = false) => {
    const id = event.turnId ? `user:${event.turnId}` : crypto.randomUUID()
    setMessages(items => upsertUserTranscript(items, {
        id,
        content: event.content,
        turnId: event.turnId,
        final,
      }))
  }, [])

  const updateVoiceMessage = useCallback((event, final = false) => {
    const responseId = event.responseId || activeVoiceResponse.current
    if (!responseId) return
    activeVoiceResponse.current = responseId
    const id = `voice:${responseId}`
    const trackedTurnId = responseTurnMap.current.get(responseId) || event.turnId || currentTurnId.current
    setMessages(items => upsertAssistantTranscript(items, {
      id,
      content: event.content,
      turnId: trackedTurnId,
      taskId: event.taskId,
      taskIds: event.taskIds,
      origin: event.origin,
      citations: event.citations,
      final,
    }))
  }, [])

  const onRealtimeEvent = useCallback(event => {
    const animationEvent = spriteAnimationEventForGatewayEvent(event)
    if (animationEvent) {
      triggerSpriteAnimation(animationEvent)
    }
    if (event.type === 'turn.started') {
      noteInteraction()
      currentTurnId.current = event.turnId || ''
      activeVoiceResponse.current = ''
      stickToBottom.current = true
      setActivity(t('正在听你说'))
    }
    if (event.type === 'gateway.disconnected') {
      setActivity(t('qwen-audio-agent Gateway 已断开，正在重连'))
      setAgentTasks(items => items.map(task => (
        [
          'queued',
          'running',
          'delegated',
          'finalizing',
          'cancelling',
          'responding',
        ].includes(task.phase)
          ? { ...task, phase: 'disconnected' }
          : task
      )))
    }
    void applyDesktopClientState(event, {
      desktop: desktopOrbMode,
      bridge: window.qwenAudioAgentDesktop,
      onLifecycle: setDesktopLifecycle,
      lastWakeAt: lastWakeAtRef.current,
    }).catch(() => {})
    if (
      event.type === 'voice.sleep'
      && event.state === 'detected'
      && desktopOrbMode
    ) {
      window.qwenAudioAgentDesktop?.wake()
    }
    if (event.type === 'gateway.connected') {
      fetch(`api/conversations/${encodeURIComponent(sessionId)}/messages`)
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(payload => {
          if (sessionIdRef.current !== sessionId) return
          setMessages(items => mergeConversationHistory(items, payload.messages))
        })
        .catch(() => {})
      fetch(`api/tasks?sessionId=${encodeURIComponent(sessionId)}`)
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(payload => {
          const serverTasks = payload.tasks || []
          const byId = new Map(serverTasks.map(task => [task.id, task]))
          setAgentTasks(items => {
            const known = new Set(items.map(task => task.id))
            const reconciled = items.flatMap(task => {
              const current = byId.get(task.id)
              if (current && taskDeliverySettled(current)) return []
              if (current) return [taskView(current, task)]
              if (task.phase !== 'disconnected') return [task]
              return [{
                ...task,
                phase: 'failed',
                error: t('网关重连后未找到这次后台执行，请重新提交。'),
              }]
            })
            serverTasks
              .filter(task => (
                taskNeedsPresentation(task)
                && !known.has(task.id)
              ))
              .reverse()
              .forEach(task => reconciled.push(taskView(task)))
            return reconciled
          })
        })
        .catch(() => {})
    }
    if (event.type === 'voice.deactivated') {
      setVoiceEnabled(false)
      setWaitingForVoice(false)
      setActivity(t('{holder}正在使用语音', { holder: frontendLabel(event.holder) }))
    }
    if (
      event.type === 'voice.ownership'
      && event.state === 'busy'
      && voiceEnabled
    ) {
      setVoiceEnabled(false)
      setWaitingForVoice(false)
      setActivity(t('{holder}正在使用语音', { holder: frontendLabel(event.holder) }))
    }
    if (event.type === 'voice.ownership' && event.state === 'available') {
      if (shouldClaimReleasedVoice(event, waitingForVoice)) {
        setWaitingForVoice(false)
        setVoiceEnabled(true)
        setActivity(t('正在接入语音'))
      } else if (!voiceEnabled) {
        setActivity(t('待命'))
      }
    }
    if (event.type === 'voice.state') {
      if (
        event.turnId
        && event.turnId !== currentTurnId.current
        && event.origin === 'model'
      ) return
      if (event.state === 'listening') setActivity(t('正在听你说'))
      if (event.state === 'processing' && !agentTurnIds.current.has(currentTurnId.current)) {
        setActivity(t('正在处理'))
      }
      if (event.state === 'idle' && !agentTurnIds.current.has(currentTurnId.current)) {
        setActivity(t('待命'))
      }
    }
    if (event.type === 'transcript.delta' && event.role === 'user') {
      updateUserTranscript(event)
    }
    if (event.type === 'transcript.final' && event.role === 'user') {
      updateUserTranscript(event, true)
    }
    if (event.type === 'transcript.discard' && event.role === 'user') {
      setMessages(items => discardUserTranscript(items, event.turnId))
    }
    if (event.type === 'response.started') {
      activeVoiceResponse.current = event.responseId
      if (event.turnId) {
        responseTurnMap.current.set(event.responseId, event.turnId)
        if (responseTurnMap.current.size > 100) {
          responseTurnMap.current.delete(responseTurnMap.current.keys().next().value)
        }
      }
      if (
        event.turnId === currentTurnId.current
        && !agentTurnIds.current.has(event.turnId)
      ) {
        setActivity(t('正在回复'))
      }
    }
    if (event.type === 'transcript.delta' && event.role === 'assistant') updateVoiceMessage(event)
    if (event.type === 'transcript.final' && event.role === 'assistant') updateVoiceMessage(event, true)
    if (event.type === 'response.interrupted') {
      const id = `voice:${event.responseId}`
      setMessages(items => items.map(message => (
        message.id === id
          ? { ...message, interrupted: true, live: false }
          : message
      )))
    }
    if (event.type === 'task.accepted') {
      const task = event.task
      if (task.turnId) agentTurnIds.current.add(task.turnId)
      if (!task.turnId || task.turnId === currentTurnId.current) {
        setActivity(t('正在处理'))
      }
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => taskView(task, current),
        taskView(task),
      ))
    }
    if (event.type === 'task.running') {
      const task = event.task
      if (task.turnId) agentTurnIds.current.add(task.turnId)
      if (!task.turnId || task.turnId === currentTurnId.current) {
        setActivity(t('正在处理'))
      }
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => ({
          ...current,
          elapsedMs: task.elapsedMs || 0,
          phase: 'running',
        }),
        {
          id: task.id,
          kind: task.kind,
          objective: task.objective,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          elapsedMs: task.elapsedMs || 0,
          phase: 'running',
          turnId: task.turnId,
        },
      ))
    }
    if (event.type === 'task.progress') {
      const progress = event.task
      if (!progress.turnId || progress.turnId === currentTurnId.current) {
        setActivity(t('正在处理 · {seconds} 秒', { seconds: Math.round(progress.elapsedMs / 1000) }))
      }
      setAgentTasks(items => upsertTask(
        items,
        progress.id,
        task => taskView(progress, task),
        taskView(progress),
      ))
    }
    if (event.type === 'task.updated') {
      const task = event.task
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => taskView(task, current),
        taskView(task),
      ))
    }
    if (event.type === 'task.delegated') {
      const task = event.task
      if (!task.turnId || task.turnId === currentTurnId.current) {
        setActivity(t('进行中'))
      }
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => taskView(task, current),
        taskView(task),
      ))
    }
    if (
      event.type === 'task.finalizing'
      || event.type === 'task.cancelling'
    ) {
      const task = event.task
      if (!task.turnId || task.turnId === currentTurnId.current) {
        setActivity(event.type === 'task.finalizing'
          ? t('正在整理项目结果')
          : t('正在取消'))
      }
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => taskView(task, current),
        taskView(task),
      ))
    }
    if (
      event.type === 'task.permission.requested'
      || event.type === 'task.permission.resolved'
    ) {
      const task = event.task
      if (event.type === 'task.permission.requested') {
        setActivity(t('等待你的确认'))
      } else {
        setActivity(t('正在继续处理'))
      }
      setAgentTasks(items => upsertTask(
        items,
        task.id,
        current => taskView(task, current),
        taskView(task),
      ))
    }
    if (event.type === 'task.completed') {
      const completed = event.task
      if (completed.turnId) agentTurnIds.current.delete(completed.turnId)
      if (!completed.turnId || completed.turnId === currentTurnId.current) {
        setActivity(t('正在准备回复'))
      }
      setAgentTasks(items => upsertTask(
        items,
        completed.id,
        task => taskView(completed, task),
        taskView(completed),
      ))
    }
    if (event.type === 'task.notification.delivered') {
      const delivered = event.task
      // Delivery is acknowledged after playback ends. The assistant transcript
      // may already have removed this card, so never upsert it again here.
      setAgentTasks(items => removeDeliveredTask(items, delivered.id))
    }
    if (event.type === 'task.failed') {
      const failed = event.task
      if (failed.turnId) agentTurnIds.current.delete(failed.turnId)
      if (!failed.turnId || failed.turnId === currentTurnId.current) {
        setActivity(t('后台失败：{error}', { error: failed.error }))
      }
      setAgentTasks(items => upsertTask(
        items,
        failed.id,
        task => ({ ...taskView(failed, task), phase: 'failed' }),
        { ...taskView(failed), phase: 'failed' },
      ))
    }
    if (event.type === 'task.cancelled') {
      const cancelled = event.task
      if (cancelled.turnId) agentTurnIds.current.delete(cancelled.turnId)
      if (!cancelled.turnId || cancelled.turnId === currentTurnId.current) {
        setActivity(t('已取消'))
      }
      setAgentTasks(items => upsertTask(
        items,
        cancelled.id,
        task => ({ ...taskView(cancelled, task), phase: 'cancelled' }),
        { ...taskView(cancelled), phase: 'cancelled' },
      ))
      clearTimeout(taskDismissTimers.current.get(cancelled.id))
      taskDismissTimers.current.set(cancelled.id, setTimeout(() => {
        setAgentTasks(items => removeTaskInPhase(
          items,
          cancelled.id,
          'cancelled',
        ))
        setActivity(current => current === t('已取消') ? t('待命') : current)
        taskDismissTimers.current.delete(cancelled.id)
      }, 3000))
    }
    if (event.type === 'transcript.final' && event.role === 'assistant') {
      if (event.turnId === currentTurnId.current) setActivity(t('待命'))
      const presentedTaskIds = new Set(
        event.taskIds?.length ? event.taskIds : [event.taskId].filter(Boolean),
      )
      setAgentTasks(items => items.filter(task => (
        !presentedTaskIds.has(task.id)
        || !['responding', 'completed'].includes(task.phase)
      )))
    }
  }, [
    sessionId,
    updateUserTranscript,
    updateVoiceMessage,
    noteInteraction,
    voiceEnabled,
    waitingForVoice,
    triggerSpriteAnimation,
  ])

  // Keep the microphone alive while the desktop orb is hidden and the wake
  // word is enabled, even if the user has muted the realtime conversation.
  // Microphone mute leaves output playback active; wake-word detection still
  // needs a live input stream to resume on "你好千问" while hidden.
  const voiceEnabledForWakeWord = (
    desktopOrbMode
    && desktopLifecycle === 'hidden'
    && wakeWordEnabled
  )
  const voice = useRealtimeVoice({
    sessionId,
    enabled: voiceEnabled || voiceEnabledForWakeWord,
    suspended: desktopOrbMode && desktopLifecycle === 'hidden' && !wakeWordEnabled,
    outputMuted: false,
    // WebUI and desktop share one control contract: the toggle only changes
    // microphone capture and never closes or interrupts the output stream.
    inputOnlyMute: true,
    wakeWordOnly: voiceEnabledForWakeWord,
    clientType: desktopOrbMode ? 'desktop' : 'web',
    clientLabel: desktopOrbMode ? t('桌面端') : 'WebUI',
    clientStates: desktopOrbMode ? ['sleeping'] : [],
    takeover: takeoverRequested,
    realtimeProvider: realtimeProviderForConnection(
      realtimeProvider,
      healthValidated,
    ),
    onEvent: onRealtimeEvent,
    onInputError: message => {
      setVoiceEnabled(false)
      setWaitingForVoice(false)
      setActivity(message)
    },
  })
  const lifecycleTransition = (
    desktopOrbMode && desktopLifecycle !== 'active'
  )
  const voiceConnectionError = (
    !lifecycleTransition && voice.connectionState === 'unavailable'
  )
  const desktopRuntime = resolveDesktopRuntime({
    gateway: gatewayRuntime,
    realtime: desktopRealtimeRuntime(voice.connectionState),
    backend: desktopBackendRuntime(backend),
  })
  const desktopHasWorkingTasks = desktopOrbMode && desktopTasksWorking(agentTasks)
  // 统一视觉状态仲裁：生命周期 → 异常 → 对话态 → 后台态。
  // 后台工作态仅在桌面悬浮球展示；等待授权由播报和任务卡片承载，
  // 不占用 Agent 动画状态。WebUI 也由任务卡片承载同类信息。
  const orbVisualState = resolveOrbVisualState({
    lifecycle: desktopLifecycle,
    runtimeState: desktopOrbMode ? desktopRuntime.overall : null,
    connectionError: !desktopOrbMode && voiceConnectionError,
    connecting: !desktopOrbMode
      && voiceEnabled
      && voice.connectionState === 'connecting',
    ownershipBusy: voice.ownership.state === 'busy',
    voiceState: voice.visualState || voice.state,
    tasksWorking: desktopHasWorkingTasks,
  })
  const authorizationTask = agentTasks.find(
    task => task.authorization?.status === 'pending',
  )

  useEffect(() => {
    if (!desktopOrbMode) return
    const current = desktopRuntime.overall
    const presentation = advanceDesktopRuntimePresentation({
      current,
      readyAnnounced: runtimeReadyAnnounced.current,
    })
    runtimeReadyAnnounced.current = presentation.readyAnnounced
    if (presentation.cue) triggerSpriteAnimation(presentation.cue)
  }, [desktopRuntime.overall, triggerSpriteAnimation])

  const desktopCards = useMemo(
    () => desktopOrbMode ? desktopTaskCards(agentTasks) : [],
    [agentTasks],
  )
  useEffect(() => {
    if (!desktopCards.length) setDesktopTasksCollapsed(false)
  }, [desktopCards.length])

  useEffect(() => {
    if (!desktopOrbMode) return undefined
    window.qwenAudioAgentDesktop?.loadSurface?.()
      .then(result => setDesktopSurfaceMode(
        result?.mode === 'panel' ? 'panel' : 'orb',
      ))
      .catch(() => {})
    return undefined
  }, [])

  useEffect(() => {
    if (!desktopOrbMode) return undefined
    return window.qwenAudioAgentDesktop?.onTaskCardPlacement?.(
      setDesktopTaskLayout,
    )
  }, [])

  useEffect(() => {
    if (!desktopOrbMode) return undefined
    window.qwenAudioAgentDesktop?.setTaskCardCount(
      desktopSurfaceMode === 'panel'
        ? desktopCards.length
        : desktopTasksCollapsed ? 0 : desktopCards.length,
    )
    return undefined
  }, [desktopCards.length, desktopSurfaceMode, desktopTasksCollapsed])

  useEffect(() => {
    if (!desktopOrbMode) return undefined
    return () => window.qwenAudioAgentDesktop?.setTaskCardCount(0)
  }, [])
  const ownershipLabel = voice.ownership.holder
    ? frontendLabel(voice.ownership.holder)
    : ''

  const workSettled = desktopWorkSettled({
    tasks: agentTasks,
    messages,
    voiceState: voice.visualState || voice.state,
  })

  useEffect(() => {
    if (!desktopOrbMode) return
    if (workSettled && !previousWorkSettled.current) {
      const settledAt = Date.now()
      workSettledAtRef.current = settledAt
      setWorkSettledAt(settledAt)
    }
    previousWorkSettled.current = workSettled
  }, [workSettled])

  useEffect(() => {
    if (!desktopOrbMode) return undefined
    const bridge = window.qwenAudioAgentDesktop
    if (!bridge) return undefined
    const applyLifecycle = lifecycle => {
      if (!lifecycle?.state) return
      if (
        lifecycle.state === 'waking'
        && previousDesktopLifecycle.current !== 'waking'
      ) {
        triggerSpriteAnimation('wake', { priority: true })
      }
      previousDesktopLifecycle.current = lifecycle.state
      setDesktopLifecycle(lifecycle.state)
      if (lifecycle.state === 'waking') lastWakeAtRef.current = Date.now()
      if (lifecycle.reason === 'activity') noteInteraction()
      if (lifecycle.state === 'hidden') setActivity(t('已隐藏'))
      if (lifecycle.state === 'waking') setActivity(t('正在显示悬浮球'))
      if (lifecycle.state === 'active' && lifecycle.reason === 'ready') {
        setActivity(t('待命'))
        noteInteraction()
      }
    }
    const dispose = bridge.onLifecycle(applyLifecycle)
    bridge.loadLifecycle().then(applyLifecycle).catch(() => {})
    const onInteraction = () => noteInteraction()
    window.addEventListener('pointerdown', onInteraction)
    window.addEventListener('keydown', onInteraction)
    return () => {
      dispose()
      window.removeEventListener('pointerdown', onInteraction)
      window.removeEventListener('keydown', onInteraction)
    }
  }, [noteInteraction, triggerSpriteAnimation])

  useEffect(() => {
    if (!desktopOrbMode || desktopLifecycle !== 'waking') return
    const ready = (
      voice.connectionState === 'connected'
      && (!voiceEnabled || voice.inputReady)
    )
    if (ready || voice.connectionState === 'unavailable') {
      window.qwenAudioAgentDesktop?.lifecycleReady()
    }
  }, [
    desktopLifecycle,
    voice.connectionState,
    voice.inputReady,
    voiceEnabled,
  ])

  // 快捷键/托盘唤起只恢复窗口；Gateway 若在休眠，前台连接会停在 sleeping，
  // 需要显式唤醒才能走到 connected，否则悬浮球永远无法就绪。
  const wakeGateway = voice.wake
  useEffect(() => {
    if (!desktopOrbMode || desktopLifecycle !== 'waking') return
    wakeGateway()
  }, [desktopLifecycle, wakeGateway])

  useEffect(() => {
    if (
      !desktopOrbMode
      || desktopSurfaceMode === 'panel'
      || autoHideSeconds === 0
    ) return undefined
    if (!desktopCanHide({
      settled: workSettled,
      connectionState: voice.connectionState,
      visualError: voice.visualError,
      lifecycle: desktopLifecycle,
    })) return undefined
    const deadline = desktopHideDeadline({
      lastInteractionAt,
      workSettledAt: workSettledAtRef.current,
      timeoutSeconds: autoHideSeconds,
    })
    const timer = setTimeout(() => {
      window.qwenAudioAgentDesktop?.enterHide()
        .then(lifecycle => setDesktopLifecycle(lifecycle.state))
        .catch(() => {})
    }, Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [
    desktopLifecycle,
    desktopSurfaceMode,
    lastInteractionAt,
    voice.connectionState,
    voice.visualError,
    workSettled,
    workSettledAt,
  ])

  // Switching the front end reconnects on its own: realtimeProvider is part of
  // the realtime effect's dependencies, so changing it tears the current socket
  // down and connects again with the newly selected provider.
  const selectRealtimeProvider = value => {
    const selection = realtimeProviderSelection(value, {
      realtimeModel: modelStatus.id,
      realtimeModelProfile: modelStatus.id ? { id: modelStatus.id } : null,
      realtimeProviders,
    })
    setRealtimeProvider(selection.provider)
    setProviderNotice(selection.notice)
    if (selection.provider) {
      localStorage.setItem(
        'qwen-audio-agent.realtimeProvider',
        selection.provider,
      )
    } else {
      localStorage.removeItem('qwen-audio-agent.realtimeProvider')
    }
  }

  const inputModeLabels = {
    text: t('文字'),
    audio: t('语音'),
    image: t('图片'),
    video: t('视频'),
    observation: t('画面观察'),
    nativeVideo: t('原生视频'),
  }
  const modeList = modes => modes.map(mode => inputModeLabels[mode]).join(' / ')

  const resetSession = () => {
    taskDismissTimers.current.forEach(timer => clearTimeout(timer))
    taskDismissTimers.current.clear()
    const next = crypto.randomUUID()
    localStorage.setItem('qwen-audio-agent.session', next)
    setSessionId(next)
    setMessages([])
    setAgentTasks([])
    currentTurnId.current = ''
    activeVoiceResponse.current = ''
    responseTurnMap.current.clear()
    agentTurnIds.current.clear()
    setActivity(t('已创建新会话'))
  }

  const enableVoice = () => {
    if (!voice.activateAudio()) return
    if (voice.ownership.state === 'busy' && !takeoverRequested) {
      setWaitingForVoice(true)
      setActivity(t('等待{holder}释放语音', { holder: ownershipLabel || t('其他入口') }))
      return
    }
    setWaitingForVoice(false)
    setVoiceEnabled(true)
  }

  const disableVoice = () => {
    setWaitingForVoice(false)
    setVoiceEnabled(false)
    setActivity(t('待命'))
  }

  const sendComposerInput = parts => {
    // Sending is a browser user gesture, so it is also the earliest reliable
    // point to unlock audio playback while the microphone remains muted.
    voice.activateAudio()
    return voice.sendInput(parts)
  }

  const turns = useMemo(
    () => buildConversationTurns(messages, agentTasks),
    [messages, agentTasks],
  )

  const beginOrbDrag = event => {
    const bridge = window.qwenAudioAgentDesktop
    if (!desktopOrbMode || event.button !== 0 || !bridge) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    orbDrag.current = {
      pointerId: event.pointerId,
      lastX: event.screenX,
    }
    setOrbDragging(true)
    setOrbDragDirection('')
    bridge.dragStart(event.screenX, event.screenY)
  }

  const moveOrb = event => {
    const drag = orbDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.screenX - drag.lastX
    if (Math.abs(deltaX) >= 2) {
      setOrbDragDirection(deltaX > 0 ? 'right' : 'left')
      drag.lastX = event.screenX
    }
    window.qwenAudioAgentDesktop?.dragMove(event.screenX, event.screenY)
  }

  const endOrbDrag = event => {
    const drag = orbDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    orbDrag.current = null
    setOrbDragging(false)
    setOrbDragDirection('')
    window.qwenAudioAgentDesktop?.dragEnd()
  }

  const handleVoiceOrbClick = () => {
    if (voice.state === 'speaking') {
      voice.interrupt()
      return
    }
    enableVoice()
  }

  if (desktopOrbMode && desktopSurfaceMode === 'orb') {
    return <main className={`desktop-gallery-shell${
      desktopCards.length && !desktopTasksCollapsed ? ' has-task-cards' : ''
    }${desktopTaskLayout.placement === 'above' ? ' tasks-above' : ''}`}
    style={{ '--desktop-orb-offset-x': `${desktopTaskLayout.orbOffsetX}px` }}>
      <div className="desktop-orb-anchor">
        <section
        className={desktopOrbClassName({
          state: orbVisualState,
          enabled: voiceEnabled,
          error: voice.visualError || voiceConnectionError,
          dragging: orbDragging,
          lifecycle: desktopLifecycle,
        })}
        aria-label={`qwen-audio · ${voice.visualError || voiceConnectionError ? t('连接异常') : labelFor(orbVisualState)}`}
        title={
          desktopLifecycle === 'waking'
            ? t('正在显示悬浮球')
            : voice.error
          || (orbVisualState === 'idle' && authorizationTask
            ? taskDetail(authorizationTask)
            : orbVisualState === 'occupied' && ownershipLabel
              ? t('{holder}正在使用语音', { holder: ownershipLabel })
              : labelFor(orbVisualState))
        }
        onPointerEnter={() => triggerSpriteAnimation('hover')}
        onPointerDown={beginOrbDrag}
        onPointerMove={moveOrb}
        onPointerUp={endOrbDrag}
        onPointerCancel={endOrbDrag}
        >
        {isBuiltinOrbSkin(orbSkinId) || spriteOrbFailed
          ? (
              <DesktopFluidOrb
                style={isBuiltinOrbSkin(orbSkinId) ? orbSkinId : 'fluid'}
              />
            )
          : (
              <DesktopSpriteOrb
                skin={orbSkinId}
                state={orbVisualState}
                baseWorking={desktopHasWorkingTasks}
                dragDirection={orbDragDirection}
                cue={spriteAnimationCue}
                onCueComplete={completeSpriteAnimationCue}
                onError={() => setSpriteOrbFailed(true)}
              />
            )}
        <nav
          className="desktop-orb-controls"
          aria-label={t('语音控制')}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            className={!voiceEnabled ? 'active' : ''}
            onClick={event => {
              event.stopPropagation()
              if (voiceEnabled || waitingForVoice) {
                disableVoice()
                return
              }
              enableVoice()
            }}
            aria-label={
              voiceEnabled
                ? t('麦克风静音')
                : waitingForVoice ? t('取消等待语音') : t('开启麦克风')
            }
            title={
              voiceEnabled
                ? t('麦克风静音')
                : waitingForVoice ? t('取消等待语音') : t('开启麦克风')
            }
          >
            <OrbControlIcon type="microphone" muted={!voiceEnabled} />
          </button>
          <button
            onClick={event => {
              event.stopPropagation()
              void changeDesktopSurface('panel')
            }}
            aria-label={t('打开对话')}
            title={t('打开对话')}
          >
            <OrbControlIcon type="conversation" />
          </button>
          <button
            onClick={event => {
              event.stopPropagation()
              window.qwenAudioAgentDesktop?.openSettings()
            }}
            aria-label={t('设置')}
            title={t('设置')}
          >
            <OrbControlIcon type="settings" />
          </button>
          {desktopCards.length > 0 && <button
            onClick={event => {
              event.stopPropagation()
              setDesktopTasksCollapsed(value => !value)
            }}
            aria-label={desktopTasksCollapsed ? t('展开后台任务') : t('折叠后台任务')}
            title={desktopTasksCollapsed ? t('展开后台任务') : t('折叠后台任务')}
          >
            <OrbControlIcon type="tasks" collapsed={desktopTasksCollapsed} />
          </button>}
          <button
            className="danger"
            onClick={event => {
              event.stopPropagation()
              window.qwenAudioAgentDesktop?.quit()
            }}
            aria-label={t('退出')}
            title={t('退出')}
          >
            <OrbControlIcon type="close" />
          </button>
        </nav>
        </section>
      </div>
      {desktopCards.length > 0 && !desktopTasksCollapsed && <section
        className="desktop-task-stack"
        aria-label={t('后台任务')}
        aria-live="polite"
      >
        {desktopCards.map(task => {
          const detail = taskDetail(task)
          const title = task.delegation?.title || task.objective || taskLabel(task)
          const progress = ['completed', 'failed', 'cancelled'].includes(task.phase)
            ? taskLabel(task)
            : detail && detail !== title ? detail : taskLabel(task)
          const plan = task.activity?.findLast(item => item.kind === 'plan')
          const progressRatio = ['completed', 'failed', 'cancelled'].includes(task.phase)
            ? 1
            : plan?.total > 0 ? plan.completed / plan.total : null
          return <article
            key={task.id}
            className={`desktop-task-card ${task.phase}`}
            title={detail}
          >
            <strong>{title}</strong>
            <span className="desktop-task-state">
              <i aria-hidden="true" />
              <small>{progress}</small>
            </span>
            <span
              className={`desktop-task-progress${progressRatio == null ? '' : ' determinate'}`}
              style={progressRatio == null ? undefined : {
                '--desktop-task-progress': `${Math.max(0, Math.min(1, progressRatio)) * 100}%`,
              }}
              aria-hidden="true"
            />
          </article>
        })}
      </section>}
    </main>
  }

  const renderTask = agentTask => <aside
    key={`task:${agentTask.id}`}
    className={`agent-task ${agentTask.phase}`}
  >
    <span className="task-spinner" aria-hidden="true" />
    <div>
      <b>{taskLabel(agentTask)}</b>
      <small>{taskDetail(agentTask)}</small>
    </div>
    {!['failed', 'disconnected'].includes(agentTask.phase) && <div className="task-controls">
      {agentTask.authorization?.status === 'pending' && <>
        <button
          className="permission-allow"
          disabled={agentTask.authorization.submitting}
          onClick={() => respondToPermission(
            agentTask.id,
            agentTask.authorization,
            'always',
          )}
        >
          {agentTask.authorization.submitting
            ? t('正在提交')
            : t('本会话始终允许')}
        </button>
        <button
          className="permission-deny"
          disabled={agentTask.authorization.submitting}
          onClick={() => respondToPermission(
            agentTask.id,
            agentTask.authorization,
            'reject',
          )}
        >
          {t('拒绝')}
        </button>
        {agentTask.authorization.error && <small className="permission-error">
          {agentTask.authorization.error}
        </small>}
      </>}
      <time>{Math.max(0, Math.round(agentTask.elapsedMs / 1000))}s</time>
    </div>}
  </aside>

  const renderMessage = message => <article
    key={message.id}
    className={`${message.role}${message.companion ? ' companion' : ''}`}
  >
    <label>{message.role === 'user'
      ? t('你')
      : message.companion ? resultLabel(message) : 'qwen-audio'}</label>
    <MessageContent
      role={message.role}
      content={message.content}
      live={message.live}
      citations={message.citations}
    />
    {message.interrupted && <small className="interrupted">{t('已打断')}</small>}
  </article>

  return <main className={`app${
    desktopOrbMode ? ' desktop-conversation-panel' : ''
  }`}>
    <header>
      <div className="brand"><span>V</span><div>qwen-audio-agent<small>REALTIME VOICE · LIVE</small></div></div>
      <a
        className="backend"
        href={backend.url || undefined}
        target="_blank"
        rel="noreferrer"
        title={backend.url ? t('打开 {label}', { label: backend.label }) : backend.label}
      >
        <i className={backend.ready ? 'ready' : ''} />
        {backend.label}
      </a>
      <div className="model-status" title={modelStatus.id}>
        <b>{modelStatus.label || t('模型信息不可用')}</b>
        {modelStatus.metadataStatus === 'current'
          ? <>
              <small>{t('模型支持：{modes}', {
                modes: modeList(modelStatus.modelInputModes),
              })}</small>
              <small>{t('Web 传输：{modes}', {
                modes: modeList(modelStatus.transportInputModes),
              })}</small>
            </>
          : <small>{t('模型能力信息不可用')}</small>}
        {providerNotice && <small className="provider-notice" role="status">
          {t(providerNotice)}
        </small>}
      </div>
      {realtimeProviders.length > 1 && <select
        className="ghost frontend-provider"
        value={realtimeProvider}
        onChange={event => selectRealtimeProvider(event.target.value)}
        title={t('选择前台语音引擎')}
        aria-label={t('选择前台语音引擎')}
      >
        <option value="">{t('前台：默认（{label}）', { label: frontend.label })}</option>
        {realtimeProviders.map(item => <option key={item.key} value={item.key}>
          {t('前台：{label}', { label: item.label })}
        </option>)}
      </select>}
      <div className="status">
        <i className={orbVisualState} /><span>{labelFor(orbVisualState)}</span>
      </div>
      <button
        className={`ghost${desktopOrbMode ? ' desktop-new-session' : ''}`}
        onClick={resetSession}
        aria-label={t('新会话')}
        title={desktopOrbMode ? t('新会话') : undefined}
      >{desktopOrbMode ? '＋' : t('新会话')}</button>
      <button
        className={[
          'voice',
          voiceEnabled ? 'active' : '',
          waitingForVoice ? 'waiting' : '',
        ].filter(Boolean).join(' ')}
        aria-label={voiceEnabled
          ? t('麦克风静音')
          : waitingForVoice ? t('取消等待') : t('开启麦克风')}
        title={desktopOrbMode
          ? voiceEnabled
            ? t('麦克风静音')
            : waitingForVoice ? t('取消等待') : t('开启麦克风')
          : undefined}
        onClick={() => {
          if (voiceEnabled || waitingForVoice) {
            disableVoice()
            return
          }
          enableVoice()
        }}
      >
        {desktopOrbMode
          ? <OrbControlIcon type="microphone" muted={!voiceEnabled} />
          : voiceEnabled
            ? t('麦克风静音')
            : waitingForVoice ? t('取消等待') : t('开启麦克风')}
      </button>
      {desktopOrbMode && <button
        className="ghost desktop-panel-collapse"
        onClick={() => void changeDesktopSurface('orb')}
        title={t('收起为悬浮球')}
      >
        <OrbControlIcon type="collapse" />
      </button>}
    </header>

    <section className="workspace">
      <div className="hero">
        <button
          className={`orb ${orbVisualState}`}
          onClick={handleVoiceOrbClick}
          aria-label={t('语音交互')}
        >
          <span />
        </button>
        <p>VOICE FRONTEND</p>
        <h1>{t('你说，我来调度。')}</h1>
        <small>{voice.error || activity}</small>
      </div>

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
        {!turns.length && <div className="empty">
          <b>{t('试着说')}</b>
          <span>{t('“帮我查一下今天的 AI 新闻，并整理成三点摘要。”')}</span>
        </div>}
        {turns.map(turn => <section
          key={turn.id}
          className={`conversation-turn${turn.standalone ? ' standalone' : ''}`}
        >
          {turn.beforeActivities.map(renderMessage)}
          {turn.tasks.map(renderTask)}
          {turn.afterActivities.map(renderMessage)}
        </section>)}
      </div>

      {composerEnabled && <MultimodalComposer
        onSend={sendComposerInput}
        compact={desktopOrbMode}
      />}

    </section>
  </main>
}
