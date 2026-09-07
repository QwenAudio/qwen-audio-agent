import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/protocol/realtime-events.mjs'
import {
  createGatewayClientState,
  reduceGatewayClientState,
} from '../../shared/gateway/client-state.mjs'
import {
  displayInputText,
  inputFileParts,
  inputText,
} from '../../shared/input-parts.mjs'
import { createLogger } from '../../shared/logger.mjs'
import { GatewayClient } from '../../shared/gateway/client-sdk.mjs'
import { gatewayReferenceClientCapabilities } from '../../shared/gateway/client-profiles.mjs'
import { formatCitationLines } from '../../shared/citation-display.mjs'
import { startMacVoiceIO } from './macos-voice-io.mjs'
import { startPortAudioVoiceIO } from './portaudio-voice-io.mjs'
import { createPlayback } from './playback.mjs'
import {
  assertInteractiveTerminal,
  audioModeForPlatform,
  connectMessage,
  fullDuplexFallbackHint,
  helpText,
  microphoneControlEvent,
  parseArguments,
  permissionStatusText,
  readTuiHealth,
  realtimeModelStatusText,
  websocketUrl,
} from './runtime-configuration.mjs'
import {
  completeTranscript,
  createPersistentTerminalRenderer,
  createTerminalTranscriptRenderer,
  createTranscriptDisplay,
  createTurnStatusDisplay,
} from './terminal-renderers.mjs'
import {
  inputPartsFromText,
} from './input-parts.mjs'
import { isExitCommand } from './terminal-commands.mjs'

const ANSI = {
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[90m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
}

function style(text, color) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

export {
  assertInteractiveTerminal,
  audioModeForPlatform,
  connectMessage,
  fullDuplexFallbackHint,
  helpText,
  microphoneControlEvent,
  parseArguments,
  permissionStatusText,
  readTuiHealth,
  realtimeModelStatusText,
  websocketUrl,
}

function requestLabel(task) {
  return String(task?.objective || '正在处理用户请求')
}

function frontendLabel(holder) {
  return holder?.label || {
    desktop: '桌面端',
    cli: '终端',
    web: 'WebUI',
  }[holder?.type] || '其他前端'
}

export function canSendMicrophoneAudio({
  connected,
  muted,
  captureEnabled,
}) {
  return Boolean(connected && !muted && captureEnabled)
}

export function canStartTuiCapture({
  clientState,
  muted,
  closed,
  bridgeExited,
  socketOpen,
}) {
  return Boolean(
    !muted
    && clientState?.voiceReady
    && clientState?.ownership?.state === 'active'
    && !closed
    && !bridgeExited
    && socketOpen,
  )
}

export function performManualInterrupt({
  playback,
  transcriptRenderer,
  socket,
  startMicrophone,
  print,
}) {
  playback.clear('user_interruption')
  transcriptRenderer.cancel()
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send({ type: 'interrupt' })
  }
  startMicrophone()
  print(style('[已手动打断，麦克风已恢复]', 'yellow'))
}


export {
  completeTranscript,
  createPersistentTerminalRenderer,
  createPlayback,
  createTerminalTranscriptRenderer,
  createTranscriptDisplay,
  createTurnStatusDisplay,
}

export async function runTui(options = parseArguments(process.argv.slice(2))) {
  const audioMode = audioModeForPlatform(process.platform, options.audioMode)
  if (options.help) {
    process.stdout.write(
      'qwen-audio-agent Voice TUI\n\n'
      + '用法：qwenaudio tui [--url URL] [--session ID] '
      + '[--audio-mode half|full]\n\n'
      + `${helpText(audioMode)}\n`,
    )
    return
  }

  assertInteractiveTerminal()
  const { cookie, health } = await readTuiHealth(options.url, {
    accessToken: options.accessToken,
  })

  let headers = cookie ? { Cookie: cookie } : {}
  let inputSampleRate = health.realtimeInputSampleRate || 16000
  let muted = false
  let closed = false
  let socket = null
  let reconnectTimer = null
  let reconnectDelay = 500
  let connectedOnce = false
  let gatewayClientState = createGatewayClientState()
  let everOwnedVoice = false
  let captureEnabled = false
  let captureStateSent = false
  let audioBridge = null
  let playback = null
  let handleTerminalLine = async () => {}
  let stagedInputParts = []
  let reconcileStagedInputParts = () => {}
  const typedTranscripts = []
  const pendingPermissionTasks = new Set()
  let close = () => {}
  let resolveClosed
  const closedPromise = new Promise(resolvePromise => {
    resolveClosed = resolvePromise
  })

  const transcriptRenderer = createPersistentTerminalRenderer({
    onLine: value => handleTerminalLine(value),
    onPaste: async value => {
      const parts = await inputPartsFromText(value, [], {
        attachmentOffset: stagedInputParts.length,
      })
      const files = inputFileParts(parts)
      if (!files.length) return value
      return {
        text: inputText(parts),
        apply() {
          stagedInputParts = [...stagedInputParts, ...files]
        },
      }
    },
    onChange: value => reconcileStagedInputParts(value),
    onClose: () => close(),
  })
  const print = text => transcriptRenderer.print(text)
  const setStatus = text => transcriptRenderer.setStatus(text)
  const userPrefix = style('你 >', 'cyan')
  const assistantPrefix = style('qwen-audio >', 'bold')
  const turnStatusDisplay = createTurnStatusDisplay({ print })
  const transcriptDisplay = createTranscriptDisplay({
    onUserDelta: content => transcriptRenderer.update(userPrefix, content),
    onUser: (content, event) => {
      if (typedTranscripts[0] === content) {
        typedTranscripts.shift()
        transcriptRenderer.cancel()
      } else transcriptRenderer.finish(userPrefix, content)
      turnStatusDisplay.begin(event?.turnId)
    },
    onUserDiscard: (_turnId, event) => {
      transcriptRenderer.discardPreview()
      if (
        event?.reason === 'turn_invalid'
        && pendingPermissionTasks.size > 0
      ) {
        print(style('[没有听清授权回答，请再说一次]', 'yellow'))
      }
    },
    onAssistantDelta: content => transcriptRenderer.stream(assistantPrefix, content),
    onAssistant: (content, event) => {
      transcriptRenderer.finish(assistantPrefix, content)
      const citations = formatCitationLines(event?.citations)
      if (citations) print(style(citations, 'dim'))
      turnStatusDisplay.assistantFinished(event?.turnId)
    },
    onReset: () => {
      transcriptRenderer.cancel()
      turnStatusDisplay.reset()
    },
  })
  const handleSigint = () => close()
  const handleSigterm = () => close()
  const cleanup = () => {
    if (closed) return
    closed = true
    clearTimeout(reconnectTimer)
    playback?.close()
    audioBridge?.close()
    transcriptRenderer.close()
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    resolveClosed()
  }
  close = () => {
    cleanup()
    if (socket?.readyState < WebSocket.CLOSING) socket.close()
  }
  const sendMicrophoneAudio = chunk => {
    if (canSendMicrophoneAudio({
      connected: socket?.readyState === WebSocket.OPEN,
      muted,
      captureEnabled,
    })) {
      socket.send({
        type: 'audio.append',
        audio: chunk.toString('base64'),
      })
    }
  }
  reconcileStagedInputParts = value => {
    const next = stagedInputParts.filter(part => (
      String(value || '').includes(String(part?.source?.text?.value || ''))
    ))
    if (next.length === stagedInputParts.length) return
    stagedInputParts = next
  }

  const startVoiceIO = audioMode.audioBackend === 'coreaudio'
    ? startMacVoiceIO
    : startPortAudioVoiceIO

  const fallbackHint = fullDuplexFallbackHint(audioMode)
  let fallbackHintPrinted = false
  const printFallbackHint = () => {
    if (!fallbackHint || fallbackHintPrinted) return
    fallbackHintPrinted = true
    print(style(`[建议] ${fallbackHint}`, 'yellow'))
  }
  const reportAudioError = message => {
    print(`${style('[音频]', 'red')} ${message}`)
    printFallbackHint()
  }

  let bridgeExited = false
  try {
    audioBridge = await startVoiceIO({
      captureSampleRate: inputSampleRate,
      duplexMode: audioMode.fullDuplex ? 'full' : 'half',
      onAudio: sendMicrophoneAudio,
      onPlaybackStarted: responseId => playback?.started(responseId),
      onPlaybackEnded: responseId => playback?.ended(responseId),
      onError: reportAudioError,
      onExit: ({ code, signal }) => {
        bridgeExited = true
        if (!closed) {
          print(style(
            `[音频设备已停止：${code ?? signal ?? 'unknown'}]`,
            'red',
          ))
          printFallbackHint()
          close()
        }
      },
    })
  } catch (error) {
    cleanup()
    if (!fallbackHint) throw error
    throw new Error(`${error.message}\n建议：${fallbackHint}`, { cause: error })
  }
  if (closed) {
    audioBridge.close()
    return
  }
  const setCaptureEnabled = enabled => {
    const next = Boolean(enabled)
    if (captureStateSent && captureEnabled === next) return false
    captureEnabled = next
    captureStateSent = true
    audioBridge.setCaptureEnabled(next)
    return true
  }
  setCaptureEnabled(false)

  playback = createPlayback({
    audioSink: audioBridge,
    onError: message => print(`${style('[播放错误]', 'red')} ${message}`),
    onStarted: responseId => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send({
          type: GatewayClientEvent.PLAYBACK_STARTED,
          responseId,
        })
      }
    },
    onEnded: responseId => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send({
          type: GatewayClientEvent.PLAYBACK_ENDED,
          responseId,
        })
      }
    },
    onCancelled: (responseId, reason = '') => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send({
          type: GatewayClientEvent.PLAYBACK_CANCELLED,
          responseId,
          ...(reason ? { reason } : {}),
        })
      }
    },
    onIdle: () => {
      if (!audioMode.captureDuringPlayback) startMicrophone()
    },
  })

  const startMicrophone = () => {
    if (!canStartTuiCapture({
      clientState: gatewayClientState,
      muted,
      closed,
      bridgeExited,
      socketOpen: socket?.readyState === WebSocket.OPEN,
    })) return
    if (setCaptureEnabled(true)) {
      setStatus(`已连接 · 麦克风已开启 · ${audioMode.shortLabel}`)
      print(`[麦克风已开启 · ${inputSampleRate} Hz · ${audioMode.shortLabel}]`)
    }
  }

  const sendTextInput = async text => {
    if (!text.trim()) return
    const referencedParts = stagedInputParts.filter(part => (
      text.includes(String(part?.source?.text?.value || ''))
    ))
    const parts = await inputPartsFromText(text, referencedParts)
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway 尚未连接')
    }
    socket.send({
      type: GatewayClientEvent.INPUT_MESSAGE,
      parts,
    })
    const transcript = displayInputText(parts)
    stagedInputParts = []
    typedTranscripts.push(transcript)
    transcriptRenderer.finish(userPrefix, transcript)
  }

  const setMuted = value => {
    muted = value
    if (muted) {
      setCaptureEnabled(false)
      setStatus('麦克风已静音 · 语音回复保持开启')
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(microphoneControlEvent(true))
      }
      print(style(
        '[麦克风已静音，语音输入不会被识别；输入 /mute 恢复]',
        'yellow',
      ))
      if (pendingPermissionTasks.size > 0) {
        print(style('[正在等待授权，恢复麦克风后再回答]', 'yellow'))
      }
    } else {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(microphoneControlEvent(false))
      }
      print(style('[麦克风已恢复]', 'green'))
      setStatus('麦克风正在恢复 · 语音回复保持开启')
      startMicrophone()
    }
  }

  const handleGatewayMessage = raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    gatewayClientState = reduceGatewayClientState(gatewayClientState, event)
    if (event.type === GatewayServerEvent.VOICE_READY) {
      const nextRate = Number(event.inputSampleRate) || inputSampleRate
      if (nextRate !== inputSampleRate) {
        print(`${style('[音频配置错误]', 'red')} Gateway 要求 ${nextRate} Hz，`
          + `但音频设备已按 ${inputSampleRate} Hz 启动`)
        close()
        return
      }
      if (gatewayClientState.ownership.state === 'active') startMicrophone()
    }
    if (
      event.type === GatewayServerEvent.VOICE_CONNECTION
      && event.state === 'unavailable'
    ) {
      setCaptureEnabled(false)
      print(`${style('[语音前台连接失败]', 'red')} ${event.message || '请检查前台服务配置'}`)
    }
    if (event.type === GatewayServerEvent.VOICE_OWNERSHIP) {
      if (event.state === 'active') {
        everOwnedVoice = true
        startMicrophone()
      } else if (event.state === 'busy') {
        setCaptureEnabled(false)
        playback.clear()
        const holder = frontendLabel(event.holder)
        if (!everOwnedVoice) {
          print(style(
            `[语音正由${holder}使用；请先关闭当前连接]`,
            'yellow',
          ))
          close()
        } else {
          muted = true
          print(style(`[语音正由${holder}使用]`, 'yellow'))
        }
      }
    }
    if (event.type === GatewayServerEvent.VOICE_DEACTIVATED) {
      muted = true
      setCaptureEnabled(false)
      playback.clear()
      transcriptRenderer.cancel()
      print(style('[语音已切换到另一窗口]', 'yellow'))
    }
    if (event.type === GatewayServerEvent.PLAYBACK_CLEAR) {
      playback.clear(event.reason || '')
      transcriptRenderer.cancel()
      if (!audioMode.captureDuringPlayback) startMicrophone()
    }
    if (event.type === GatewayServerEvent.AUDIO_DELTA) {
      if (!audioMode.captureDuringPlayback) setCaptureEnabled(false)
      const accepted = playback.write(
        event.audio,
        Number(event.sampleRate) || OUTPUT_SAMPLE_RATE,
        event.responseId,
      )
      if (!audioMode.captureDuringPlayback && !accepted) startMicrophone()
    }
    if (event.type === GatewayServerEvent.AUDIO_DONE) {
      playback.done(event.responseId)
    }
    transcriptDisplay.handle(event)
    if (event.type === 'task.running') {
      turnStatusDisplay.status(
        event,
        `${style('[正在处理]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.delegated') {
      // A pending permission is the actionable state. Do not immediately
      // obscure it with the broader delegated state for the same task.
      if (event.task.authorization?.status !== 'pending') {
        turnStatusDisplay.status(
          event,
          `${style('[项目执行中]', 'yellow')} ${requestLabel(event.task)}`,
        )
      }
    }
    if (event.type === 'task.finalizing') {
      turnStatusDisplay.status(
        event,
        `${style('[正在整理结果]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.cancelling') {
      turnStatusDisplay.status(
        event,
        `${style('[正在取消]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.permission.requested') {
      if (event.task?.id) pendingPermissionTasks.add(event.task.id)
      turnStatusDisplay.status(
        event,
        `${style('[需要确认]', 'yellow')} ${permissionStatusText(event.task)}`,
      )
      if (muted) {
        print(style(
          '[正在等待授权，但麦克风已静音；输入 /mute 恢复后再回答]',
          'yellow',
        ))
      }
    }
    if (
      event.type === 'task.permission.resolved'
      || event.type === 'task.completed'
      || event.type === 'task.failed'
      || event.type === 'task.cancelled'
    ) {
      if (event.task?.id) pendingPermissionTasks.delete(event.task.id)
    }
    if (event.type === 'task.failed') {
      turnStatusDisplay.status(
        event,
        `${style('[处理失败]', 'red')} ${
          event.task.error || requestLabel(event.task)
        }`,
      )
    }
    if (event.type === 'error') {
      transcriptRenderer.cancel()
      print(`${style('[错误]', 'red')} ${event.message}`)
    }
  }

  const restoreTasks = tasks => {
    for (const task of tasks || []) {
      if (!['queued', 'running', 'delegated', 'finalizing', 'cancelling'].includes(task.status)
        && task.authorization?.status !== 'pending') continue
      const type = task.authorization?.status === 'pending'
        ? 'task.permission.requested'
        : `task.${task.status}`
      handleGatewayMessage(JSON.stringify({ type, task }))
    }
  }

  const connectGateway = () => {
    if (closed || bridgeExited) return
    const nextClient = new GatewayClient({
      url: websocketUrl(options.url, options.sessionId),
      createSocket: (url, socketOptions = {}) => new WebSocket(url, {
        headers: { ...headers, ...socketOptions.headers },
      }),
      accessToken: options.accessToken,
      takeover: options.takeover === true,
      clientType: 'cli',
      clientLabel: 'CLI',
      clientInstanceId: `tui-${process.pid}`,
      capabilities: gatewayReferenceClientCapabilities('cli'),
      reconnect: false,
      configure: () => connectMessage({
        voiceEnabled: true,
        inputEnabled: !muted,
        outputEnabled: true,
      }),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onEvent: event => handleGatewayMessage(JSON.stringify(event)),
      onRecovery: recovery => restoreTasks(recovery.tasks),
      onStatus: status => {
        if (socket !== nextClient || closed) return
        if (status.state === 'connected') {
          reconnectDelay = 500
          gatewayClientState = reduceGatewayClientState(gatewayClientState, {
            type: GatewayServerEvent.GATEWAY_CONNECTED,
          })
          setStatus('Gateway 已连接 · 语音服务准备中')
          if (connectedOnce) {
            print(style('[qwen-audio-agent 已重新连接]', 'green'))
          } else {
            connectedOnce = true
            print(
              `${style('qwen-audio-agent Voice TUI', 'bold')} · ${health.realtimeLabel || health.realtimeModelProfile?.label || health.realtimeModel || 'Realtime'} → ${health.backend?.label || health.backend?.kind || 'Gateway'}\n`
              + `${realtimeModelStatusText(health)}\n`
              + `会话：${options.sessionId}\n`
              + `音频：${audioMode.label}\n`
              + `${helpText(audioMode)}\n`,
            )
          }
        } else if (status.state === 'unavailable') {
          if (!closed) print(`${style('[连接错误]', 'red')} ${status.error?.message || '连接失败'}`)
        } else if (status.state === 'recovery_failed') {
          print(style(`[任务状态] ${status.error.message}`, 'yellow'))
        } else if (status.state === 'occupied') {
          setStatus('Gateway 正由同一用户的另一个客户端使用')
          print(style(
            '[客户端占用] 请先断开当前活动客户端，或从支持接管的客户端显式接管',
            'yellow',
          ))
          close()
        } else if (status.state === 'replaced') {
          setStatus('当前连接已被同一用户的另一个客户端接管')
          print(style('[连接已被接管]', 'yellow'))
          close()
        } else if (status.state === 'revoked') {
          setStatus('当前远程设备的访问权限已被撤销')
          print(style('[访问已撤销] 请重新配对远程 Gateway', 'yellow'))
          close()
        } else if (status.state === 'disconnected') {
          gatewayClientState = reduceGatewayClientState(gatewayClientState, {
            type: GatewayServerEvent.GATEWAY_DISCONNECTED,
          })
          setCaptureEnabled(false)
          playback.clear()
          transcriptDisplay.reset()
          if (closed) {
            print('qwen-audio-agent 连接已关闭。')
          } else if (bridgeExited) {
            cleanup()
          } else {
            setStatus('Gateway 已断开 · 正在自动重连 · /exit 或 Ctrl-C 可退出')
            print(style('[qwen-audio-agent 连接中断，正在重连]', 'yellow'))
            scheduleReconnect()
          }
        }
      },
    })
    socket = nextClient
    nextClient.start()
  }

  const scheduleReconnect = () => {
    if (closed || bridgeExited) return
    const delay = reconnectDelay
    reconnectDelay = Math.min(5000, reconnectDelay * 2)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(async () => {
      if (closed || bridgeExited) return
      try {
        const refreshed = await readTuiHealth(options.url, {
          accessToken: options.accessToken,
        })
        const nextRate = Number(
          refreshed.health.realtimeInputSampleRate,
        ) || inputSampleRate
        if (nextRate !== inputSampleRate) {
          print(
            `${style('[音频配置已变化]', 'red')} Gateway 现在要求 `
            + `${nextRate} Hz，请重新启动 TUI`,
          )
          close()
          return
        }
        headers = refreshed.cookie ? { Cookie: refreshed.cookie } : {}
        connectGateway()
      } catch (error) {
        setStatus('等待 Gateway · 正在自动重连 · /exit 或 Ctrl-C 可退出')
        print(style(`[等待 Gateway] ${error.message}`, 'yellow'))
        scheduleReconnect()
      }
    }, delay)
  }

  handleTerminalLine = async value => {
    const text = String(value || '').trim()
    const [command = ''] = text.split(/\s+/)
    if (isExitCommand(command)) {
      close()
    } else if (['/mute', '/m'].includes(command)) {
      setMuted(!muted)
    } else if (['/interrupt', '/x'].includes(command)) {
      if (!audioMode.manualInterrupt) {
        throw new Error('当前全双工模式支持直接用语音打断，无需手动打断')
      }
      performManualInterrupt({
        playback,
        transcriptRenderer,
        socket,
        startMicrophone,
        print,
      })
    } else if (['/help', '/h'].includes(command)) {
      print(helpText(audioMode))
    } else if (command.startsWith('/')) {
      throw new Error(`未知命令：${command}；输入 /help 查看帮助`)
    } else {
      await sendTextInput(value)
    }
  }

  connectGateway()

  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  await closedPromise
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const logger = createLogger({
    component: 'tui',
    fileName: 'tui.log',
    consoleEnabled: false,
  })
  logger.info('tui.started')
  runTui()
    .then(() => logger.info('tui.stopped'))
    .catch(error => {
      logger.error('tui.failed', { error })
      process.stderr.write(`qwen-audio-agent TUI 启动失败：${error.message}\n`)
      process.exitCode = 1
    })
}
