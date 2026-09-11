// 客服工作台的语音通道：麦克风采集 → PCM16 → 网关，以及下行音频的排队播放。
//
// 【为什么不直接复用 web/src/useRealtimeVoice.js】
// 那是个 React Hook，依赖 useRef/useReducer 和 shared/ 下六个模块，
// 而这个工作台是一张纯 HTML + 原生 module 的页面。硬搬要么引入 React，
// 要么把 Hook 拆成不认识的样子。协议本身只有三件事：
//   上行 {type:'audio.append', audio: base64(PCM16 @16k)}
//   下行 {type:'audio.delta',  audio: base64, sampleRate: 24000, responseId}
//   打断 voice.state=listening 或 playback.clear 时停播
// 三十行能说完，所以这里按协议重写，只借它的编解码与排队算法
// （web/src/audio.js 与 useRealtimeVoice.js:479 的 play）。
//
// 【AudioContext 和 mediaDevices 都从外面注入】
// 不是为了好看：这两个东西在 Node 里不存在，注入之后编解码、排队时序、
// 采样率切换都能在单测里跑，不必靠人对着浏览器听。

const DEFAULT_INPUT_RATE = 16_000
const DEFAULT_OUTPUT_RATE = 24_000
// 2048 帧 @48kHz ≈ 43ms 一片。太大耳朵能听出延迟，太小 base64 开销占比上升。
// 和 web/ 前端取同一个值，出问题时两边行为可比。
const FRAME_SIZE = 2048
// 排队起播的安全余量。0 会让第一片赶不上 currentTime 而被静默丢掉。
const SCHEDULE_MARGIN = 0.02

export function resample(input, from, to) {
  if (from === to) return input
  const ratio = from / to
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const before = Math.floor(position)
    const after = Math.min(input.length - 1, before + 1)
    output[index] = input[before] * (1 - position + before) + input[after] * (position - before)
  }
  return output
}

export function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => {
    // 【必须先夹到 [-1,1]】麦克风增益拉高时会出现 1.2 这种值，
    // 不夹的话 setInt16 溢出回绕成一个大负数 —— 听起来是爆音，不是变大声。
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, clamped * 0x7fff, true)
  })
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function decodePcm(base64) {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const output = new Float32Array(bytes.length / 2)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 0x8000
  }
  return output
}

// 下行播放。
//
// 【为什么要自己排队，而不是收到一片就 start()】
// 网关是流式吐音频的，一句话会拆成几十片陆续到达。各自立刻播会叠在一起
// 变成一团噪声。cursor 记住"上一片播到哪个时刻"，下一片就从那里接上。
//
// 【为什么必须把播放进度回报给网关】
// 网关不是"发完音频就算说完了"。助手的转写在服务端会先堆在 pendingTranscripts
// 里，只有收到客户端的 playback.started 才 flush —— 而那一步同时负责把这句话
// 写进对话记录（realtime-presentation-runtime.mjs 的 #flushPendingTranscripts
// → #emitTranscript → conversationSync.record）。
//
// 不回报的后果实测过：客服的声音正常播出来，但对话记录里【一条 assistant 都没有】，
// /api/conversations/:id/messages 全是 user。出口审计因此也没有原话可审。
// 这不是漏了个通知，是漏了半条数据链。
export function createPlaybackQueue({
  contextFactory,
  outputRate = DEFAULT_OUTPUT_RATE,
  onStarted = () => {},
  onEnded = () => {},
  onCancelled = () => {},
} = {}) {
  if (typeof contextFactory !== 'function') {
    throw new Error('createPlaybackQueue 需要 contextFactory')
  }
  let context = null
  let cursor = 0
  let sources = []
  // 每个 responseId 一份进度。responseId 是网关认这句话的凭据 ——
  // 回报时不带它，网关不知道确认的是哪一句，会直接丢掉这条回报。
  const tracked = new Map()

  const ensure = () => {
    // 【必须在用户手势里首次创建】浏览器的自动播放策略会把非手势里创建的
    // AudioContext 挂成 suspended，表现是"连上了但一点声音都没有"。
    // 所以这个函数由「开始通话」按钮那条路径首次触发。
    if (!context) context = contextFactory()
    if (context.state === 'suspended') context.resume?.()
    return context
  }

  const stateOf = (responseId) => {
    if (!tracked.has(responseId)) {
      tracked.set(responseId, {
        pending: 0, started: false, done: false, ended: false, timer: null,
      })
    }
    return tracked.get(responseId)
  }

  const markStarted = (responseId) => {
    const state = tracked.get(responseId)
    if (!state || state.started || state.ended) return
    state.started = true
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    onStarted(responseId)
  }

  const finishIfDone = (responseId) => {
    const state = tracked.get(responseId)
    // 【三个条件都要】音频还在陆续到达（!done）时，已排的片子会短暂归零。
    // 那时候报 ended 等于告诉网关"这句说完了"，而后半句还没播。
    if (!state || state.ended || !state.done || state.pending > 0) return
    state.ended = true
    tracked.delete(responseId)
    onEnded(responseId)
  }

  return {
    // 由点击回调同步调用，不能等第一片下行音频到达后才创建上下文。
    prepare: ensure,
    play(base64, sampleRate = outputRate, responseId = '') {
      const active = ensure()
      const samples = decodePcm(base64)
      if (!samples.length) return null
      const buffer = active.createBuffer(1, samples.length, sampleRate || outputRate)
      buffer.copyToChannel(samples, 0)
      const source = active.createBufferSource()
      source.buffer = buffer
      source.connect(active.destination)
      const start = Math.max(active.currentTime + SCHEDULE_MARGIN, cursor)
      cursor = start + buffer.duration
      sources.push(source)
      const state = responseId ? stateOf(responseId) : null
      if (state) state.pending += 1
      source.onended = () => {
        sources = sources.filter(other => other !== source)
        if (!state) return
        state.pending -= 1
        // 【onended 也当作"已开始"的兜底】播完必然播过。定时器在后台标签页
        // 会被浏览器节流，只靠它可能迟到几秒甚至不触发；web/ 前端为
        // Electron 也留了同一条兜底（见 web/src/playback-lifecycle.js 的注释）。
        markStarted(responseId)
        finishIfDone(responseId)
      }
      source.start(start)
      if (state && !state.started && state.timer === null) {
        // 墙钟到点不代表音频已播：suspended 时音频时钟会停住。
        const checkStarted = () => {
          state.timer = null
          if (tracked.get(responseId) !== state || state.started) return
          if (active.state === 'running' && active.currentTime >= start) {
            markStarted(responseId)
          } else {
            state.timer = setTimeout(checkStarted, 20)
          }
        }
        state.timer = setTimeout(checkStarted, Math.max(0, (start - active.currentTime) * 1000))
      }
      return { start, end: cursor }
    },
    // 网关说这一句的音频发完了（audio.done）。在此之前不能报 ended。
    markDone(responseId) {
      if (!responseId || !tracked.has(responseId)) return
      stateOf(responseId).done = true
      finishIfDone(responseId)
    },
    // 打断。客户开口时必须立刻闭嘴 —— 这是语音场景里最容易被忽略、
    // 但一旦缺失就显得很蠢的一件事（客户已经在说下一句，客服还在念上一句）。
    stop() {
      for (const source of sources) {
        try {
          source.stop()
        } catch {
          // 还没 start 的 source 调 stop 会抛，忽略即可。
        }
      }
      sources = []
      cursor = 0
      // 【被打断的那句要销账】不报的话网关会一直等这句的 ended，
      // 它那份 response context 也就一直挂着不回收。
      for (const [responseId, state] of [...tracked]) {
        if (state.timer !== null) clearTimeout(state.timer)
        tracked.delete(responseId)
        if (state.ended) continue
        onCancelled(responseId, state.started)
      }
    },
    close() {
      this.stop()
      context?.close?.()
      context = null
    },
    get playing() {
      return sources.length > 0
    },
  }
}

// 上行采集。
//
// 【用 ScriptProcessorNode 而不是 AudioWorklet】
// AudioWorklet 要单独一个 .js 文件走 addModule，而这个工作台是单页 + 一个模块，
// 多一个文件就多一条要在 server.mjs 里手写的路由。web/ 前端同样用的
// ScriptProcessor（useRealtimeVoice.js:814），行为可比。它确实是废弃 API，
// 但在这个 demo 的寿命内不会消失。
export function createMicrophoneStream({
  mediaDevices,
  contextFactory,
  onChunk,
  onError = () => {},
  targetRate = DEFAULT_INPUT_RATE,
  frameSize = FRAME_SIZE,
} = {}) {
  if (!mediaDevices?.getUserMedia) throw new Error('createMicrophoneStream 需要 mediaDevices')
  if (typeof contextFactory !== 'function') throw new Error('createMicrophoneStream 需要 contextFactory')
  if (typeof onChunk !== 'function') throw new Error('createMicrophoneStream 需要 onChunk')

  let media = null
  let context = null
  let processor = null
  let source = null
  let muted = false
  let rate = targetRate
  let generation = 0
  let starting = null

  const release = () => {
    processor?.disconnect()
    source?.disconnect()
    if (processor) processor.onaudioprocess = null
    for (const track of media?.getTracks?.() || []) track.stop()
    context?.close?.()?.catch?.(onError)
    media = null
    context = null
    processor = null
    source = null
  }

  return {
    async start() {
      if (media) return true
      if (starting) return starting
      const version = generation
      const pending = (async () => {
        // 三个开关都开着：客服场景是免提通话，回声消除关掉的话
        // 模型会听见自己刚说的话并当成客户在讲。
        const granted = await mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        // 授权弹窗不能取消；挂断后迟到的流必须关闭，且不能覆盖下一通。
        if (version !== generation) {
          for (const track of granted.getTracks()) track.stop()
          return false
        }
        media = granted
        try {
          context = contextFactory()
          source = context.createMediaStreamSource(media)
          processor = context.createScriptProcessor(frameSize, 1, 1)
          processor.onaudioprocess = event => {
            if (muted) return
            try {
              const input = event.inputBuffer.getChannelData(0)
              // 采样率由 voice.ready 事件告知，可能不是 16k；context.sampleRate
              // 通常是 48k，两者不等时必须重采样，否则服务端听到的是变调的话。
              onChunk(pcmBase64(resample(input, context.sampleRate, rate)))
            } catch (error) {
              onError(error)
            }
          }
          source.connect(processor)
          // 【必须接到 destination，即使不想听见自己】
          // ScriptProcessorNode 不接终点在部分实现里不会被拉动，onaudioprocess
          // 一次都不触发 —— 表现是"麦克风灯亮着但没有任何数据上行"。
          processor.connect(context.destination)
          return true
        } catch (error) {
          release()
          throw error
        }
      })()
      starting = pending
      try {
        return await pending
      } finally {
        if (starting === pending) starting = null
      }
    },
    stop() {
      generation += 1
      starting = null
      release()
    },
    setMuted(value) {
      muted = Boolean(value)
    },
    setTargetRate(value) {
      if (Number.isFinite(value) && value > 0) rate = value
    },
    get active() {
      return Boolean(media)
    },
    get targetRate() {
      return rate
    },
  }
}

export const VOICE_DEFAULTS = Object.freeze({
  inputRate: DEFAULT_INPUT_RATE,
  outputRate: DEFAULT_OUTPUT_RATE,
  frameSize: FRAME_SIZE,
})
