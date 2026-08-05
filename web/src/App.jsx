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
  finalAssistantContent,
  insertByTurn,
  upsertUserTranscript,
} from './message-order.js'
import MessageContent from './MessageContent.jsx'
import DesktopFluidOrb from './DesktopFluidOrb.jsx'
import { desktopOrbClassName } from './orb-presentation.js'
import { resultLabel } from './presentation.js'
import {
  removeDeliveredTask,
  removeTaskInPhase,
  taskDetail,
  taskLabel,
  taskView,
} from './task-view.js'
import useRealtimeVoice, {
  retainedRealtimeProvider,
  shouldClaimReleasedVoice,
} from './useRealtimeVoice.js'
import { requestedSessionId } from './session.js'
import { initialVoiceEnabled } from './voice-defaults.js'
import {
  applyDesktopClientState,
  desktopAutoHideSeconds,
  desktopCanHide,
  desktopHideDeadline,
  desktopWorkSettled,
} from './desktop-hide.js'

const desktopOrbMode = (
  new URLSearchParams(window.location.search).get('desktop') === 'orb'
)
const takeoverRequested = (
  new URLSearchParams(window.location.search).get('takeover') === '1'
)
const orbStyle = (
  new URLSearchParams(window.location.search).get('orbStyle') === 'goo'
    ? 'goo'
    : 'fluid'
)
const autoHideSeconds = desktopAutoHideSeconds(window.location.search)

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
    idle: '待命',
    listening: '正在听',
    thinking: '思考中',
    speaking: '正在说',
    connecting: '正在连接语音前台',
    occupied: '其他入口正在使用',
    hidden: '已隐藏',
    waking: '正在显示',
  }[state] || state
}

function frontendLabel(holder) {
  return holder?.label || {
    desktop: '桌面端',
    cli: '终端',
    web: 'WebUI',
  }[holder?.type] || '其他入口'
}

function OrbControlIcon({ type, muted = false }) {
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
  const [activity, setActivity] = useState('正在检查后台 Agent')
  const [frontend, setFrontend] = useState({ label: 'Realtime Agent' })
  const [realtimeProviders, setRealtimeProviders] = useState([])
  const [realtimeProvider, setRealtimeProvider] = useState(
    () => localStorage.getItem('qwen-audio-agent.realtimeProvider') || '',
  )
  const [backend, setBackend] = useState({ label: 'Agent', ready: false })
  const [agentTasks, setAgentTasks] = useState([])
  const [orbDragging, setOrbDragging] = useState(false)
  const [desktopLifecycle, setDesktopLifecycle] = useState('active')
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
  const suppressOrbClick = useRef(false)
  const previousWorkSettled = useRef(true)
  const workSettledAtRef = useRef(workSettledAt)

  const noteInteraction = useCallback(() => {
    setLastInteractionAt(Date.now())
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
        throw new Error(payload.error || `请求失败（${response.status}）`)
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
                error: `没有提交成功：${error.message}`,
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
    fetch('api/health')
      .then(async response => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (cancelled) return
        const label = payload.backend?.label || payload.backend?.kind || 'Agent'
        setFrontend({
          label: payload.realtimeLabel || payload.realtimeProvider || 'Realtime Agent',
        })
        setRealtimeProviders(payload.realtimeProviders || [])
        // A front end persisted by an earlier visit may no longer exist on this
        // server (removed provider, different deployment). Sending it would be
        // refused on every connect, so the stale selection is dropped in favour
        // of the server default instead of leaving the client stuck.
        setRealtimeProvider(current => {
          const retained = retainedRealtimeProvider(
            current,
            payload.realtimeProviders,
          )
          if (retained !== current) {
            localStorage.removeItem('qwen-audio-agent.realtimeProvider')
          }
          return retained
        })
        setBackend({
          label,
          ready: response.ok && payload.backend?.ok,
          url: payload.backend?.uiPath || payload.backend?.baseUrl || '',
        })
        setActivity(response.ok ? 'Gateway 已连接' : '能力服务尚未连接')
      })
      .catch(() => {
        if (!cancelled) setActivity('qwen-audio-agent Gateway 尚未连接')
      })
    return () => {
      cancelled = true
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
    setMessages(items => {
      const index = items.findIndex(item => item.id === id)
      if (index < 0) return insertByTurn(items, {
          id,
          role: 'assistant',
          content: final
            ? finalAssistantContent(event.content)
            : event.content || '',
          turnId: trackedTurnId,
          taskId: event.taskId,
          taskIds: event.taskIds,
          origin: event.origin,
          deliverySequence: event.deliverySequence,
          live: !final,
      })
      const next = [...items]
      next[index] = {
        ...next[index],
        content: final
          ? finalAssistantContent(event.content, next[index].content)
          : next[index].content + (event.content || ''),
        turnId: trackedTurnId || next[index].turnId,
        taskId: event.taskId || next[index].taskId,
        taskIds: event.taskIds || next[index].taskIds,
        origin: event.origin || next[index].origin,
        deliverySequence: event.deliverySequence || next[index].deliverySequence,
        live: !final,
      }
      return next
    })
  }, [])

  const updateTimelineItem = useCallback(item => {
    if (!item?.content) return
    setMessages(items => {
      const id = `inline:${item.id || item.taskId || crypto.randomUUID()}`
      const existing = items.findIndex(message => message.id === id)
      const message = {
        id,
        role: 'assistant',
        content: item.content,
        title: item.title,
        turnId: item.turnId || currentTurnId.current,
        taskId: item.taskId,
        companion: true,
        final: true,
      }
      if (existing < 0) return insertByTurn(items, message)
      const next = [...items]
      next[existing] = message
      return next
    })
  }, [])

  const onRealtimeEvent = useCallback(event => {
    if (event.type === 'turn.started') {
      noteInteraction()
      currentTurnId.current = event.turnId || ''
      activeVoiceResponse.current = ''
      stickToBottom.current = true
      setActivity('正在听你说')
    }
    if (event.type === 'gateway.disconnected') {
      setActivity('qwen-audio-agent Gateway 已断开，正在重连')
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
    }).catch(() => {})
    if (event.type === 'gateway.connected') {
      fetch(`api/tasks?sessionId=${encodeURIComponent(sessionId)}`)
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(payload => {
          const serverTasks = payload.tasks || []
          const byId = new Map(serverTasks.map(task => [task.id, task]))
          setAgentTasks(items => {
            const known = new Set(items.map(task => task.id))
            const reconciled = items.map(task => {
              const current = byId.get(task.id)
              if (current) return taskView(current, task)
              if (task.phase !== 'disconnected') return task
              return {
                ...task,
                phase: 'failed',
                error: '网关重连后未找到这次后台执行，请重新提交。',
              }
            })
            serverTasks
              .filter(task => (
                task.workState === 'active'
                && !known.has(task.id)
              ))
              .reverse()
              .forEach(task => reconciled.push(taskView(task)))
            return reconciled
          })
        })
        .catch(() => {})
      fetch(`api/timeline?sessionId=${encodeURIComponent(sessionId)}`)
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(payload => {
          for (const item of payload.items || []) updateTimelineItem(item)
        })
        .catch(() => {})
    }
    if (event.type === 'voice.deactivated') {
      setVoiceEnabled(false)
      setWaitingForVoice(false)
      setActivity(`${frontendLabel(event.holder)}正在使用语音`)
    }
    if (
      event.type === 'voice.ownership'
      && event.state === 'busy'
      && voiceEnabled
    ) {
      setVoiceEnabled(false)
      setWaitingForVoice(false)
      setActivity(`${frontendLabel(event.holder)}正在使用语音`)
    }
    if (event.type === 'voice.ownership' && event.state === 'available') {
      if (shouldClaimReleasedVoice(event, waitingForVoice)) {
        setWaitingForVoice(false)
        setVoiceEnabled(true)
        setActivity('正在接入语音')
      } else if (!voiceEnabled) {
        setActivity('待命')
      }
    }
    if (event.type === 'voice.state') {
      if (
        event.turnId
        && event.turnId !== currentTurnId.current
        && event.origin === 'model'
      ) return
      if (event.state === 'listening') setActivity('正在听你说')
      if (event.state === 'thinking' && !agentTurnIds.current.has(currentTurnId.current)) {
        setActivity('正在理解')
      }
      if (event.state === 'idle' && !agentTurnIds.current.has(currentTurnId.current)) {
        setActivity('待命')
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
    if (event.type === 'timeline.inline' && event.item?.content) {
      updateTimelineItem(event.item)
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
        setActivity('正在回复')
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
        setActivity('正在处理')
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
        setActivity('正在处理')
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
          objective: task.objective,
          elapsedMs: task.elapsedMs || 0,
          phase: 'running',
          turnId: task.turnId,
        },
      ))
    }
    if (event.type === 'task.progress') {
      const progress = event.task
      if (!progress.turnId || progress.turnId === currentTurnId.current) {
        setActivity(`正在处理 · ${Math.round(progress.elapsedMs / 1000)} 秒`)
      }
      setAgentTasks(items => upsertTask(
        items,
        progress.id,
        task => taskView(progress, task),
        taskView(progress),
      ))
    }
    if (event.type === 'task.delegated') {
      const task = event.task
      if (!task.turnId || task.turnId === currentTurnId.current) {
        setActivity('项目正在执行')
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
          ? '正在整理项目结果'
          : '正在取消')
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
        setActivity('等待你的确认')
      } else {
        setActivity('正在继续处理')
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
        setActivity(voiceEnabled ? '正在准备回复' : '处理完成')
      }
      setAgentTasks(items => upsertTask(
        items,
        completed.id,
        task => {
          const next = taskView(completed, task)
          return !voiceEnabled && next.phase === 'responding'
            ? { ...next, phase: 'completed' }
            : next
        },
        (() => {
          const next = taskView(completed)
          return !voiceEnabled && next.phase === 'responding'
            ? { ...next, phase: 'completed' }
            : next
        })(),
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
        setActivity(`后台失败：${failed.error}`)
      }
      setAgentTasks(items => upsertTask(
        items,
        failed.id,
        task => ({ ...task, phase: 'failed', error: failed.error }),
      ))
    }
    if (event.type === 'task.cancelled') {
      const cancelled = event.task
      if (cancelled.turnId) agentTurnIds.current.delete(cancelled.turnId)
      if (!cancelled.turnId || cancelled.turnId === currentTurnId.current) {
        setActivity('已取消')
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
        setActivity(current => current === '已取消' ? '待命' : current)
        taskDismissTimers.current.delete(cancelled.id)
      }, 3000))
    }
    if (event.type === 'transcript.final' && event.role === 'assistant') {
      if (event.turnId === currentTurnId.current) setActivity('待命')
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
    updateTimelineItem,
    updateUserTranscript,
    updateVoiceMessage,
    noteInteraction,
    voiceEnabled,
    waitingForVoice,
  ])

  const voice = useRealtimeVoice({
    sessionId,
    enabled: voiceEnabled,
    suspended: desktopOrbMode && desktopLifecycle === 'hidden',
    outputMuted: false,
    inputOnlyMute: desktopOrbMode,
    clientType: desktopOrbMode ? 'desktop' : 'web',
    clientLabel: desktopOrbMode ? '桌面端' : 'WebUI',
    clientStates: desktopOrbMode ? ['sleeping'] : [],
    takeover: takeoverRequested,
    realtimeProvider,
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
  const visualVoiceState = desktopLifecycle === 'hidden'
    ? 'hidden'
    : desktopLifecycle === 'waking'
      ? 'waking'
      : voice.ownership.state === 'busy'
    ? 'occupied'
    : voiceConnectionError
      ? 'error'
      : voiceEnabled && voice.connectionState === 'connecting'
      ? 'connecting'
      : voice.visualState || voice.state
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
      setDesktopLifecycle(lifecycle.state)
      if (lifecycle.reason === 'activity') noteInteraction()
      if (lifecycle.state === 'hidden') setActivity('已隐藏')
      if (lifecycle.state === 'waking') setActivity('正在显示悬浮球')
      if (lifecycle.state === 'active' && lifecycle.reason === 'ready') {
        setActivity('待命')
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
  }, [noteInteraction])

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

  useEffect(() => {
    if (!desktopOrbMode || autoHideSeconds === 0) return undefined
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
    setRealtimeProvider(value)
    if (value) {
      localStorage.setItem('qwen-audio-agent.realtimeProvider', value)
    } else {
      localStorage.removeItem('qwen-audio-agent.realtimeProvider')
    }
  }

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
    setActivity('已创建新会话')
  }

  const enableVoice = () => {
    if (!voice.activateAudio()) return
    if (voice.ownership.state === 'busy' && !takeoverRequested) {
      setWaitingForVoice(true)
      setActivity(`等待${ownershipLabel || '其他入口'}释放语音`)
      return
    }
    setWaitingForVoice(false)
    setVoiceEnabled(true)
  }

  const disableVoice = () => {
    setWaitingForVoice(false)
    setVoiceEnabled(false)
    setActivity('待命')
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
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
    }
    suppressOrbClick.current = false
    setOrbDragging(true)
    bridge.dragStart(event.screenX, event.screenY)
  }

  const moveOrb = event => {
    const drag = orbDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (
      Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >= 4
    ) {
      drag.moved = true
    }
    window.qwenAudioAgentDesktop?.dragMove(event.screenX, event.screenY)
  }

  const endOrbDrag = event => {
    const drag = orbDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressOrbClick.current = drag.moved
    orbDrag.current = null
    setOrbDragging(false)
    window.qwenAudioAgentDesktop?.dragEnd()
  }

  const handleOrbClick = () => {
    if (suppressOrbClick.current) {
      suppressOrbClick.current = false
      return
    }
    if (voice.state === 'speaking') {
      voice.interrupt()
      return
    }
    if (desktopOrbMode && (voiceEnabled || waitingForVoice)) {
      disableVoice()
      return
    }
    enableVoice()
  }

  if (desktopOrbMode) {
    return <main className="desktop-gallery-shell">
      <section
        ref={voice.levelElementRef}
        className={desktopOrbClassName({
          state: visualVoiceState,
          enabled: voiceEnabled,
          error: voice.visualError || voiceConnectionError,
          dragging: orbDragging,
          lifecycle: desktopLifecycle,
        })}
        aria-label={`qwen-audio · ${voice.visualError || voiceConnectionError ? '连接异常' : labelFor(visualVoiceState)}`}
        title={
          desktopLifecycle === 'waking'
            ? '正在显示悬浮球'
            : voice.error
          || (visualVoiceState === 'occupied' && ownershipLabel
            ? `${ownershipLabel}正在使用语音`
            : labelFor(visualVoiceState))
        }
        onClick={handleOrbClick}
        onPointerDown={beginOrbDrag}
        onPointerMove={moveOrb}
        onPointerUp={endOrbDrag}
        onPointerCancel={endOrbDrag}
      >
        <DesktopFluidOrb style={orbStyle} />
        <nav
          className="desktop-orb-controls"
          aria-label="语音控制"
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
                ? '麦克风静音'
                : waitingForVoice ? '取消等待语音' : '开启麦克风'
            }
            title={
              voiceEnabled
                ? '麦克风静音'
                : waitingForVoice ? '取消等待语音' : '开启麦克风'
            }
          >
            <OrbControlIcon type="microphone" muted={!voiceEnabled} />
          </button>
          <button
            onClick={event => {
              event.stopPropagation()
              window.qwenAudioAgentDesktop?.openSettings()
            }}
            aria-label="设置"
            title="设置"
          >
            <OrbControlIcon type="settings" />
          </button>
          <button
            className="danger"
            onClick={event => {
              event.stopPropagation()
              window.qwenAudioAgentDesktop?.quit()
            }}
            aria-label="退出"
            title="退出"
          >
            <OrbControlIcon type="close" />
          </button>
        </nav>
      </section>
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
          {agentTask.authorization.submitting ? '正在提交' : '始终允许'}
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
          拒绝
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
      ? '你'
      : message.companion ? resultLabel(message) : 'qwen-audio'}</label>
    <MessageContent
      role={message.role}
      content={message.content}
      live={message.live}
    />
    {message.interrupted && <small className="interrupted">已打断</small>}
  </article>

  return <main className="app">
    <header>
      <div className="brand"><span>V</span><div>qwen-audio-agent<small>REALTIME VOICE · LIVE</small></div></div>
      <a
        className="backend"
        href={backend.url || undefined}
        target="_blank"
        rel="noreferrer"
        title={backend.url ? `打开 ${backend.label}` : backend.label}
      >
        <i className={backend.ready ? 'ready' : ''} />
        {backend.label}
      </a>
      {realtimeProviders.length > 1 && <select
        className="ghost frontend-provider"
        value={realtimeProvider}
        onChange={event => selectRealtimeProvider(event.target.value)}
        title="选择前台语音引擎"
        aria-label="选择前台语音引擎"
      >
        <option value="">前台：默认（{frontend.label}）</option>
        {realtimeProviders.map(item => <option key={item.key} value={item.key}>
          前台：{item.label}
        </option>)}
      </select>}
      <div className="status"><i className={visualVoiceState} />{labelFor(visualVoiceState)}</div>
      <button className="ghost" onClick={resetSession}>新会话</button>
      <button
        className={[
          'voice',
          voiceEnabled ? 'active' : '',
          waitingForVoice ? 'waiting' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => {
          if (voiceEnabled || waitingForVoice) {
            disableVoice()
            return
          }
          enableVoice()
        }}
      >
        {voiceEnabled
          ? '关闭语音'
          : waitingForVoice ? '取消等待' : '开启语音'}
      </button>
    </header>

    <section className="workspace">
      <div className="hero">
        <button
          ref={voice.levelElementRef}
          className={`orb ${visualVoiceState}`}
          onClick={handleOrbClick}
          aria-label="语音交互"
        >
          <span />
        </button>
        <p>VOICE FRONTEND</p>
        <h1>你说，我来调度。</h1>
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
          <b>试着说</b>
          <span>“帮我查一下今天的 AI 新闻，并整理成三点摘要。”</span>
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

    </section>
  </main>
}
