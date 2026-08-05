// qwen-audio-agent 文本 CLI:连接网关 /api/realtime,打字对话 + 任务管理。
// 与 Web/TUI 同一会话体系;不采音(connect 时 voiceEnabled=false,回复以文字流呈现)。
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const ESC = ''
const DIM = `${ESC}[90m`
const CYAN = `${ESC}[36m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[31m`
const BOLD = `${ESC}[1m`
const RST = `${ESC}[0m`

export function parseArguments(argv) {
  const options = {
    url: process.env.QWEN_AUDIO_AGENT_URL || 'http://127.0.0.1:3101',
    sessionId: process.env.QWEN_AUDIO_AGENT_SESSION_ID || 'cli-main',
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url' && argv[index + 1]) options.url = argv[++index]
    else if (argv[index] === '--session' && argv[index + 1]) {
      options.sessionId = argv[++index]
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      options.help = true
    }
  }
  options.url = options.url.replace(/\/+$/, '')
  return options
}

export function websocketUrl(baseUrl, sessionId) {
  const url = new URL('/api/realtime', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

export function helpText() {
  return [
    '输入文字回车即发送。命令:',
    '  /tasks        查看当前会话任务',
    '  /cancel [id]  取消任务',
    '  /help         帮助',
    '  /quit         退出',
  ].join('\n')
}

export function taskLine(task) {
  const seconds = Math.max(0, Math.round((task.elapsedMs || 0) / 1000))
  return `${task.id}  ${task.status}  ${seconds}s  ${task.objective}`
}

export function selectCancellableTask(tasks, requestedId) {
  if (requestedId) return tasks.find(task => task.id === requestedId) || null
  return tasks.find(task => (
    ['queued', 'running', 'delegated', 'finalizing'].includes(task.status)
  )) || null
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.()[0]
    || response.headers.get('set-cookie')
    || ''
  return raw.split(';', 1)[0]
}

export async function runCli(options = parseArguments(process.argv.slice(2))) {
  if (options.help) {
    process.stdout.write(
      `qwen-audio-agent 文本 CLI\n\n用法:npm run tui:text -- [--url URL] [--session ID]\n\n${helpText()}\n`,
    )
    return
  }

  const healthResponse = await fetch(`${options.url}/api/health`)
  const cookie = cookieFrom(healthResponse)
  const health = await healthResponse.json()
  if (!healthResponse.ok) {
    throw new Error(health.backend?.error || 'qwen-audio-agent 或后台 Agent 尚未就绪')
  }
  const headers = cookie ? { Cookie: cookie } : {}

  const api = async (path, init = {}) => {
    const response = await fetch(`${options.url}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`)
    return payload
  }

  const socket = new WebSocket(websocketUrl(options.url, options.sessionId), { headers })
  const print = text => process.stdout.write(`${text}\n`)
  let streaming = false
  const startedResponses = new Set()

  const opened = new Promise((resolvePromise, rejectPromise) => {
    socket.once('open', resolvePromise)
    socket.once('error', rejectPromise)
  })
  socket.on('open', () => {
    socket.send(JSON.stringify({
      type: 'connect',
      voiceEnabled: true,  // 启用输出通道以接收任务播报;CLI 不发音频、忽略音频帧
      textOnly: true,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: 'zh-CN',
    }))
    print(`${DIM}已连接(文本模式,会话 ${options.sessionId});/help 查看命令${RST}`)
  })

  socket.on('message', raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (event.type === 'audio.delta') {
      // 文本客户端不放音频,但需要回执播放状态:
      // 网关把 assistant 转写押到 playback.started 之后才下发(与播放同步的设计)。
      const responseId = String(event.responseId || '')
      if (responseId && !startedResponses.has(responseId)) {
        startedResponses.add(responseId)
        socket.send(JSON.stringify({ type: 'playback.started', responseId }))
      }
    } else if (event.type === 'audio.done') {
      const responseId = String(event.responseId || '')
      if (responseId && startedResponses.has(responseId)) {
        startedResponses.delete(responseId)
        socket.send(JSON.stringify({ type: 'playback.ended', responseId }))
      }
    } else if (event.type === 'transcript.delta' && event.role === 'assistant') {
      if (!streaming) {
        process.stdout.write(`${BOLD}\u{1F916} ${RST}`)
        streaming = true
      }
      process.stdout.write(event.content || '')
    } else if (event.type === 'transcript.final') {
      if (event.role === 'assistant') {
        if (streaming) {
          process.stdout.write('\n')
          streaming = false
        } else if (event.content) {
          print(`${BOLD}\u{1F916} ${RST}${event.content}`)
        }
      }
    } else if (event.type === 'timeline.inline') {
      const content = event.item?.content || event.item?.markdown || ''
      if (content) print(`${CYAN}── 时间线 ──${RST}\n${content}`)
    } else if (event.type === 'error') {
      if (streaming) {
        process.stdout.write('\n')
        streaming = false
      }
      print(`${RED}[错误] ${event.message}${RST}`)
    }
  })
  socket.on('close', () => print(`${RED}连接已断开${RST}`))

  await opened
  const readline = createInterface({ input: process.stdin })
  for await (const line of readline) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('/')) {
      const [command, argument] = text.split(/\s+/)
      if (command === '/quit') break
      if (command === '/help') {
        print(helpText())
        continue
      }
      try {
        if (command === '/tasks') {
          const payload = await api(
            `/api/tasks?sessionId=${encodeURIComponent(options.sessionId)}`,
          )
          const tasks = payload.tasks || []
          if (!tasks.length) print(`${DIM}(无任务)${RST}`)
          tasks.forEach(task => print(`  ${YELLOW}${taskLine(task)}${RST}`))
        } else if (command === '/cancel') {
          const payload = await api(
            `/api/tasks?sessionId=${encodeURIComponent(options.sessionId)}`,
          )
          const tasks = payload.tasks || []
          const target = selectCancellableTask(tasks, argument)
          if (!target) {
            print(`${RED}没有可取消的任务${RST}`)
            continue
          }
          await api(`/api/tasks/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
          print(`${DIM}· 已取消 ${target.id}${RST}`)
        } else {
          print(`${RED}未知命令 ${command}${RST}`)
        }
      } catch (error) {
        print(`${RED}[命令失败] ${error.message}${RST}`)
      }
      continue
    }
    socket.send(JSON.stringify({ type: 'text.message', text, textOnly: true }))
  }
  socket.close()
  readline.close()
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCli().catch(error => {
    process.stderr.write(`${RED}${error.message}${RST}\n`)
    process.exit(1)
  })
}
