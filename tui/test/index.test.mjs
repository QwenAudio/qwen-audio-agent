import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertInteractiveTerminal,
  audioModeForPlatform,
  canSendMicrophoneAudio,
  completeTranscript,
  connectMessage,
  createPlayback,
  createTerminalTranscriptRenderer,
  createTranscriptDisplay,
  createTurnStatusDisplay,
  fullDuplexFallbackHint,
  helpText,
  microphoneControlEvent,
  parseArguments,
  permissionStatusText,
  performManualInterrupt,
  readTuiHealth,
  websocketUrl,
} from '../src/index.mjs'

test('m key controls microphone input without disabling voice output', () => {
  assert.deepEqual(microphoneControlEvent(true), {
    type: 'input.mute',
  })
  assert.deepEqual(microphoneControlEvent(false), {
    type: 'input.unmute',
    takeover: false,
  })
})

test('shows a permission operation without duplicating the spoken question', () => {
  assert.equal(
    permissionStatusText({
      authorization: { summary: 'Edit snake.py' },
    }),
    'Edit snake.py',
  )
  assert.doesNotMatch(
    permissionStatusText({ authorization: {} }),
    /允许|拒绝/,
  )
})

test('keeps a streamed tail when a final transcript is unexpectedly shorter', () => {
  assert.equal(
    completeTranscript('我来帮你查一下。', '我来帮你查'),
    '我来帮你查一下。',
  )
  assert.equal(
    completeTranscript('杭州天气', '杭州天气怎么样？'),
    '杭州天气怎么样？',
  )
})

test('parses a custom gateway, session and audio mode', () => {
  const options = parseArguments([
    '--url',
    'https://voice.example.com/',
    '--session',
    'terminal-one',
    '--audio-mode',
    'full',
    '--takeover',
  ], {})
  assert.equal(options.url, 'https://voice.example.com')
  assert.equal(options.sessionId, 'terminal-one')
  assert.equal(options.audioMode, 'full')
  assert.equal(options.takeover, true)
  assert.equal(
    parseArguments([], {
      QWEN_AUDIO_AGENT_TUI_AUDIO_MODE: 'FULL',
    }).audioMode,
    'full',
  )
  assert.throws(
    () => parseArguments(['--audio-mode', 'invalid'], {}),
    /不支持的音频模式/,
  )
  assert.throws(
    () => parseArguments(['--audio-mode'], {}),
    /--audio-mode 缺少参数/,
  )
  assert.throws(
    () => parseArguments(['--unknown'], {}),
    /未知参数：--unknown/,
  )
  assert.throws(
    () => parseArguments(['--session', ''], {}),
    /--session 缺少参数/,
  )
  assert.equal(
    parseArguments(['--url', 'https://voice.example.com/path'], {}).url,
    'https://voice.example.com',
  )
})

test('builds the realtime websocket URL', () => {
  assert.equal(
    websocketUrl('https://voice.example.com', '中文 session'),
    'wss://voice.example.com/api/realtime?sessionId=%E4%B8%AD%E6%96%87+session',
  )
})

test('reports the TUI launch directory as client context', () => {
  assert.deepEqual(connectMessage({
    voiceEnabled: true,
    takeover: true,
    workingDirectory: '/Users/me/codes/snake-game',
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
  }), {
    type: 'connect',
    voiceEnabled: true,
    clientType: 'cli',
    clientLabel: 'CLI',
    takeover: true,
    workingDirectory: '/Users/me/codes/snake-game',
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
  })
})

test('advertises a muted TUI as output-capable on reconnect', () => {
  assert.deepEqual(connectMessage({
    voiceEnabled: true,
    inputEnabled: false,
    outputEnabled: true,
    takeover: false,
    workingDirectory: '/workspace',
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
  }), {
    type: 'connect',
    voiceEnabled: true,
    inputEnabled: false,
    outputEnabled: true,
    clientType: 'cli',
    clientLabel: 'CLI',
    takeover: false,
    workingDirectory: '/workspace',
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
  })
})

test('requires an interactive terminal for reliable manual controls', () => {
  assert.doesNotThrow(() => assertInteractiveTerminal({ isTTY: true }))
  assert.throws(
    () => assertInteractiveTerminal({ isTTY: false }),
    /需要交互式终端/,
  )
})

test('bounds and validates the Gateway health check', async () => {
  let request
  const result = await readTuiHealth('http://127.0.0.1:3101', {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        headers: {
          getSetCookie: () => ['qwaudio=value; Path=/; HttpOnly'],
          get: () => null,
        },
        json: async () => ({
          backend: { ok: true },
          realtimeInputSampleRate: 16000,
        }),
      }
    },
    timeoutMs: 25,
  })
  assert.equal(request.url, 'http://127.0.0.1:3101/api/health')
  assert.ok(request.init.signal)
  assert.equal(result.cookie, 'qwaudio=value')
  assert.equal(result.health.backend.ok, true)

  await assert.rejects(
    readTuiHealth('http://127.0.0.1:3101', {
      fetchImpl: async () => {
        throw new Error('offline')
      },
    }),
    /无法连接 Gateway：offline/,
  )
  await assert.rejects(
    readTuiHealth('http://127.0.0.1:3101', {
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ ready: true }),
      }),
    }),
    /缺少后台状态/,
  )
})

test('uses macOS AEC and selectable PortAudio duplex modes elsewhere', () => {
  const mac = audioModeForPlatform('darwin', 'half')
  const linux = audioModeForPlatform('linux')
  const windows = audioModeForPlatform('win32')
  const linuxFull = audioModeForPlatform('linux', 'full')
  const windowsFull = audioModeForPlatform('win32', 'full')

  assert.equal(mac.audioBackend, 'coreaudio')
  assert.equal(mac.fullDuplex, true)
  assert.equal(mac.captureDuringPlayback, true)
  assert.equal(mac.manualInterrupt, false)
  assert.equal(linux.fullDuplex, false)
  assert.equal(linux.captureDuringPlayback, false)
  assert.equal(linux.manualInterrupt, true)
  assert.equal(windows.fullDuplex, false)
  assert.equal(windows.captureDuringPlayback, false)
  assert.equal(windows.manualInterrupt, true)
  for (const mode of [linuxFull, windowsFull]) {
    assert.equal(mode.audioBackend, 'portaudio')
    assert.equal(mode.fullDuplex, true)
    assert.equal(mode.captureDuringPlayback, true)
    assert.equal(mode.manualInterrupt, false)
    assert.match(mode.label, /无 AEC/)
    assert.match(helpText(mode), /请使用耳机/)
    assert.doesNotMatch(helpText(mode), /x  手动打断当前回复/)
  }
  assert.match(helpText(mac), /macOS CoreAudio 全双工回声消除/)
  assert.match(helpText(mac), /语音打断回复/)
  assert.doesNotMatch(helpText(mac), /x  手动打断当前回复/)
  assert.match(helpText(linux), /回复播放完毕后可继续说话/)
  assert.match(helpText(linux), /按 x 可手动打断/)
  assert.doesNotMatch(helpText(linux), /输入文字|text\.message/)
  assert.equal(fullDuplexFallbackHint(mac), '')
  assert.equal(fullDuplexFallbackHint(linux), '')
  assert.match(fullDuplexFallbackHint(linuxFull), /--audio-mode half/)
})

test('drops queued microphone frames whenever half-duplex capture is gated', () => {
  assert.equal(canSendMicrophoneAudio({
    connected: true,
    muted: false,
    captureEnabled: true,
  }), true)
  assert.equal(canSendMicrophoneAudio({
    connected: true,
    muted: false,
    captureEnabled: false,
  }), false)
})

test('manual interruption works in half-duplex modes', () => {
  for (const platform of ['linux', 'win32']) {
    assert.equal(audioModeForPlatform(platform).manualInterrupt, true)
    const events = []
    performManualInterrupt({
      playback: {
        clear: reason => events.push(['clear', reason]),
      },
      transcriptRenderer: {
        cancel: () => events.push(['cancel']),
      },
      socket: {
        readyState: 1,
        send: value => events.push(['send', JSON.parse(value)]),
      },
      startMicrophone: () => events.push(['capture']),
      print: value => events.push(['print', value]),
    })
    assert.deepEqual(events.slice(0, 4), [
      ['clear', 'user_interruption'],
      ['cancel'],
      ['send', { type: 'interrupt' }],
      ['capture'],
    ])
  }
})

test('ignores late audio from a response after manual interruption', () => {
  const writes = []
  const playback = createPlayback({
    audioSink: {
      write: buffer => {
        writes.push(buffer)
        return true
      },
      clear() {},
    },
  })

  assert.equal(playback.write('AQI=', 24000, 'response-1'), true)
  playback.clear('user_interruption')
  assert.equal(playback.write('AwQ=', 24000, 'response-1'), false)
  assert.equal(writes.length, 1)
})

test('normalizes provider audio to the TUI device playback rate', () => {
  const writes = []
  const playback = createPlayback({
    audioSink: {
      write(buffer, rate, responseId) {
        writes.push({ buffer, rate, responseId })
        return true
      },
      clear() {},
    },
  })
  const source = Buffer.alloc(4)
  source.writeInt16LE(0, 0)
  source.writeInt16LE(1000, 2)

  assert.equal(
    playback.write(source.toString('base64'), 16000, 'response-1'),
    true,
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0].rate, 24000)
  assert.equal(writes[0].responseId, 'response-1')
  assert.equal(writes[0].buffer.length, 6)
})

test('uses native playback drain events instead of a wall-clock estimate', () => {
  const commands = []
  const events = []
  const playback = createPlayback({
    audioSink: {
      write(buffer, rate, responseId) {
        commands.push(['write', buffer, rate, responseId])
        return true
      },
      done(responseId) {
        commands.push(['done', responseId])
        return true
      },
      clear() {},
    },
    onStarted: responseId => events.push(['started', responseId]),
    onEnded: responseId => events.push(['ended', responseId]),
    onIdle: () => events.push(['idle']),
  })

  playback.write('AQI=', 24000, 'response-1')
  playback.done('response-1')
  playback.done('response-1')
  assert.deepEqual(events, [])
  assert.deepEqual(commands.map(command => command[0]), ['write', 'done'])

  playback.started('response-1')
  playback.ended('response-1')
  assert.deepEqual(events, [
    ['started', 'response-1'],
    ['ended', 'response-1'],
    ['idle'],
  ])
})

test('prints a late final ASR before the assistant response for that turn', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUser: content => output.push(`user:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })

  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '你好。',
  })
  assert.deepEqual(output, [])

  display.handle({
    type: 'transcript.final',
    role: 'user',
    turnId: 'turn-1',
    content: '喂，你好。',
  })
  assert.deepEqual(output, [
    'user:喂，你好。',
    'assistant:你好。',
  ])
})

test('prints later responses in the same completed turn immediately', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUser: content => output.push(`user:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })

  display.handle({
    type: 'transcript.final',
    role: 'user',
    turnId: 'turn-1',
    content: '你记得我什么？',
  })
  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我记得',
  })
  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我记得你喜欢打篮球。',
  })

  assert.deepEqual(output, [
    'user:你记得我什么？',
    'assistant:我记得你喜欢打篮球。',
  ])
})

test('streams ASR snapshots and assistant transcript without losing the final tail', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUserDelta: content => output.push(`user-delta:${content}`),
    onUser: content => output.push(`user:${content}`),
    onAssistantDelta: content => output.push(`assistant-delta:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })

  display.handle({
    type: 'transcript.delta',
    role: 'user',
    turnId: 'turn-1',
    content: '杭州',
    replace: true,
  })
  display.handle({
    type: 'transcript.delta',
    role: 'user',
    turnId: 'turn-1',
    content: '杭州天气怎么样',
    replace: true,
  })
  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我来',
  })
  display.handle({
    type: 'transcript.final',
    role: 'user',
    turnId: 'turn-1',
    content: '杭州天气怎么样？',
  })
  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '帮你查一下。',
  })
  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我来帮你查',
  })

  assert.deepEqual(output, [
    'user-delta:杭州',
    'user-delta:杭州天气怎么样',
    'user:杭州天气怎么样？',
    'assistant-delta:我来',
    'assistant-delta:我来帮你查一下。',
    'assistant:我来帮你查一下。',
  ])
})

test('appends only new assistant text and defers interleaved status lines', () => {
  const writes = []
  const stdout = {
    isTTY: true,
    columns: 40,
    write: content => writes.push(content),
  }
  const renderer = createTerminalTranscriptRenderer({ stdout })

  renderer.stream('qwen-audio >', '从前有一只')
  renderer.print('[正在处理] 查询天气')
  renderer.stream('qwen-audio >', '从前有一只小狐狸')
  renderer.finish('qwen-audio >', '从前有一只小狐狸。')

  assert.equal(
    writes.join(''),
    'qwen-audio > 从前有一只小狐狸。\n'
      + '[正在处理] 查询天气\n',
  )
})

test('shows current-turn task status after the spoken acknowledgement', () => {
  const output = []
  const status = createTurnStatusDisplay({
    print: line => output.push(line),
  })

  status.begin('turn-1')
  status.status({
    type: 'task.running',
    task: { turnId: 'turn-1' },
  }, '[正在处理] 画一个小猪')
  status.status({
    type: 'task.failed',
    task: { turnId: 'turn-1' },
  }, '[处理失败] Qoder CLI process exited with code 42')

  output.push('qwen-audio > 正在为您生成一幅可爱的小猪画作。')
  status.assistantFinished('turn-1')

  assert.deepEqual(output, [
    'qwen-audio > 正在为您生成一幅可爱的小猪画作。',
    '[正在处理] 画一个小猪',
    '[处理失败] Qoder CLI process exited with code 42',
  ])
})

test('does not defer status from an older or unknown turn', () => {
  const output = []
  const status = createTurnStatusDisplay({
    print: line => output.push(line),
  })

  status.status({
    type: 'task.failed',
    task: { turnId: 'old-turn' },
  }, '[处理失败] 旧任务失败')

  assert.deepEqual(output, ['[处理失败] 旧任务失败'])
})

test('does not split a streamed reply on a provisional user ASR snapshot', () => {
  const writes = []
  const stdout = {
    isTTY: true,
    columns: 80,
    write: content => writes.push(content),
  }
  const renderer = createTerminalTranscriptRenderer({ stdout })

  renderer.stream('qwen-audio >', '科比的影响力依然深远。这些新闻')
  renderer.update('你 >', '就')
  renderer.stream(
    'qwen-audio >',
    '科比的影响力依然深远。这些新闻都体现了曼巴精神。',
  )
  renderer.finish(
    'qwen-audio >',
    '科比的影响力依然深远。这些新闻都体现了曼巴精神。',
  )

  assert.equal(
    writes.join(''),
    'qwen-audio > 科比的影响力依然深远。这些新闻都体现了曼巴精神。\n',
  )
})

test('discarding a provisional user snapshot does not cancel an assistant stream', () => {
  const writes = []
  const renderer = createTerminalTranscriptRenderer({
    stdout: {
      isTTY: true,
      columns: 80,
      write: content => writes.push(content),
    },
  })
  const display = createTranscriptDisplay({
    onUserDelta: content => renderer.update('你 >', content),
    onUser: content => renderer.finish('你 >', content),
    onUserDiscard: () => renderer.discardPreview(),
    onAssistantDelta: content => renderer.stream('qwen-audio >', content),
    onAssistant: content => renderer.finish('qwen-audio >', content),
  })

  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    content: '回复仍在',
  })
  display.handle({
    type: 'transcript.delta',
    role: 'user',
    turnId: 'turn-1',
    content: '回声',
    replace: true,
  })
  display.handle({
    type: 'transcript.discard',
    role: 'user',
    turnId: 'turn-1',
  })
  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    content: '继续',
  })
  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    content: '回复仍在继续。',
  })

  assert.equal(writes.join(''), 'qwen-audio > 回复仍在继续。\n')
})

test('wraps and redraws a long mutable ASR preview across terminal rows', () => {
  const writes = []
  const stdout = {
    isTTY: true,
    columns: 24,
    write: content => writes.push(content),
  }
  const renderer = createTerminalTranscriptRenderer({ stdout })

  renderer.update('你 >', '这是一个很长很长的流式识别结果')
  renderer.update('你 >', '这是一个很长很长的流式识别结果更新')
  renderer.finish('你 >', '这是一个很长很长的流式识别结果更新')

  const rendered = writes.join('')
  const beforeFinal = rendered.slice(
    0,
    rendered.lastIndexOf('你 > 这是一个很长很长的流式识别结果更新\n'),
  )
  assert.match(beforeFinal, /你 > 这是一个/)
  assert.match(beforeFinal, /\n {5}流式识别结果/)
  assert.match(beforeFinal, /\u001b\[1A/)
  assert.doesNotMatch(beforeFinal, /…/)
  assert.equal(
    rendered.endsWith('你 > 这是一个很长很长的流式识别结果更新\n'),
    true,
  )
})

test('does not wait for ASR before showing an asynchronous agent result', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUser: content => output.push(`user:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })

  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'announcement-1',
    turnId: 'older-turn',
    origin: 'agent',
    content: '后台工作已经完成。',
  })

  assert.deepEqual(output, ['assistant:后台工作已经完成。'])
})

test('releases a buffered response when the user transcript is discarded', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUser: content => output.push(`user:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })

  display.handle({
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我听到了。',
  })
  display.handle({
    type: 'transcript.discard',
    role: 'user',
    turnId: 'turn-1',
  })

  assert.deepEqual(output, ['assistant:我听到了。'])
})

test('passes the discard reason to the TUI feedback handler', () => {
  const discarded = []
  const display = createTranscriptDisplay({
    onUserDiscard: (turnId, event) => {
      discarded.push({ turnId, reason: event.reason })
    },
  })

  display.handle({
    type: 'transcript.discard',
    role: 'user',
    turnId: 'turn-1',
    reason: 'turn_invalid',
  })

  assert.deepEqual(discarded, [{
    turnId: 'turn-1',
    reason: 'turn_invalid',
  }])
})

test('clears a mutable ASR preview when its turn is discarded', () => {
  const writes = []
  const renderer = createTerminalTranscriptRenderer({
    stdout: {
      isTTY: true,
      columns: 40,
      write: content => writes.push(content),
    },
  })
  const display = createTranscriptDisplay({
    onUserDelta: content => renderer.update('你 >', content),
    onUser: content => renderer.finish('你 >', content),
    onUserDiscard: () => renderer.discardPreview(),
    onReset: () => renderer.cancel(),
  })

  display.handle({
    type: 'transcript.delta',
    role: 'user',
    turnId: 'turn-1',
    content: '残留的临时识别',
    replace: true,
  })
  display.handle({
    type: 'transcript.discard',
    role: 'user',
    turnId: 'turn-1',
  })

  assert.match(writes.join(''), /\r\u001b\[2K$/)
})

test('reset releases terminal output blocked behind an interrupted response', () => {
  const writes = []
  const renderer = createTerminalTranscriptRenderer({
    stdout: {
      isTTY: true,
      columns: 40,
      write: content => writes.push(content),
    },
  })
  const display = createTranscriptDisplay({
    onUser: () => {},
    onAssistant: content => renderer.finish('qwen-audio >', content),
    onAssistantDelta: content => renderer.stream('qwen-audio >', content),
    onReset: () => renderer.cancel(),
  })

  display.handle({
    type: 'transcript.delta',
    role: 'assistant',
    responseId: 'response-1',
    content: '尚未完成的回复',
  })
  renderer.print('[连接中断，正在重连]')
  assert.doesNotMatch(writes.join(''), /连接中断/)

  display.reset()
  renderer.print('[连接中断，正在重连]')
  assert.match(writes.join(''), /连接中断，正在重连/)
})

test('prints duplicate final transcript events for one response only once', () => {
  const output = []
  const display = createTranscriptDisplay({
    onUser: content => output.push(`user:${content}`),
    onAssistant: content => output.push(`assistant:${content}`),
  })
  const userEvent = {
    type: 'transcript.final',
    role: 'user',
    turnId: 'turn-1',
    content: '查一下最新消息。',
  }
  const assistantEvent = {
    type: 'transcript.final',
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    origin: 'model',
    content: '我正在查找，请稍等。',
  }

  display.handle(userEvent)
  display.handle(assistantEvent)
  display.handle(assistantEvent)

  assert.deepEqual(output, [
    'user:查一下最新消息。',
    'assistant:我正在查找，请稍等。',
  ])
})
