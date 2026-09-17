import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMicrophoneStream,
  createPlaybackQueue,
  decodePcm,
  pcmBase64,
  resample,
} from '../voice.mjs'

// 语音通道的单测。【为什么值得测】音频出问题的表现全是"听起来不对"，
// 没有异常、没有日志 —— 变调、爆音、两个声音叠着，每一种都要靠人对着
// 浏览器听才能发现。把编解码、重采样、排队时序这三样搬到 Node 里跑，
// 至少能保证不是这些地方错的。

// AudioContext 在 Node 里不存在，所以这里造一个只记账的假货：
// 它不发声，但把每个 source 的起播时刻记下来，排队顺序就能被断言。
function fakeContext({ currentTime = 0, sampleRate = 48_000 } = {}) {
  const started = []
  // 真实浏览器里 source.stop() 会触发 onended，假货不会 —— 所以把 source
  // 存下来，让测试自己决定什么时候"播完"。
  const sources = []
  const context = {
    currentTime,
    sampleRate,
    sources,
    state: 'running',
    destination: { name: 'destination' },
    closed: false,
    resumed: 0,
    started,
    resume() {
      this.resumed += 1
    },
    close() {
      this.closed = true
    },
    createBuffer(channels, length, rate) {
      return {
        length,
        sampleRate: rate,
        duration: length / rate,
        channelData: null,
        copyToChannel(data) {
          this.channelData = data
        },
      }
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        stopped: false,
        connect() {},
        start(when) {
          started.push({ when, duration: this.buffer.duration })
        },
        stop() {
          this.stopped = true
        },
      }
      sources.push(source)
      return source
    },
  }
  return context
}

test('PCM16 编解码往返后波形基本不变', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])
  const output = decodePcm(pcmBase64(input))
  assert.equal(output.length, input.length)
  for (const [index, sample] of input.entries()) {
    // int16 量化误差上限约 1/32768。
    assert.ok(Math.abs(output[index] - sample) < 0.0001,
      `第 ${index} 个样本偏差过大：${output[index]} vs ${sample}`)
  }
})

test('超出 [-1,1] 的样本被夹住而不是溢出回绕', () => {
  // 【这条守着一个听起来像"变大声"其实是爆音的 bug】
  // 不夹的话 1.2 * 0x7fff 溢出成负数，波形上下翻转 —— 耳朵听到的是撕裂音。
  const output = decodePcm(pcmBase64(new Float32Array([1.8, -1.8])))
  assert.ok(output[0] > 0.99, `正向溢出没被夹住：${output[0]}`)
  assert.ok(output[1] < -0.99, `负向溢出没被夹住：${output[1]}`)
})

test('重采样按比例改变长度，同采样率时原样返回', () => {
  const input = new Float32Array(480)
  assert.equal(resample(input, 48_000, 16_000).length, 160)
  assert.equal(resample(input, 16_000, 48_000).length, 1440)
  // 同率必须返回同一个对象：每帧都拷一份在 43ms 一次的回调里是白烧 CPU。
  assert.equal(resample(input, 16_000, 16_000), input)
})

test('下行音频依次排队，后一片接在前一片结束处', () => {
  const context = fakeContext({ currentTime: 1 })
  const queue = createPlaybackQueue({ contextFactory: () => context })
  const chunk = pcmBase64(new Float32Array(2_400)) // 24k 采样率下正好 0.1 秒

  const first = queue.play(chunk, 24_000)
  const second = queue.play(chunk, 24_000)

  // 第一片要留出安全余量，否则赶不上 currentTime 会被静默丢掉。
  assert.ok(first.start > 1, `第一片起播时刻应大于 currentTime：${first.start}`)
  assert.ok(Math.abs(first.end - (first.start + 0.1)) < 1e-9)
  // 【关键】第二片必须接在第一片之后。都从 currentTime 起播的话，
  // 一句话的几十片会叠成一团噪声。
  assert.equal(second.start, first.end)
})

test('打断会停掉全部在播的源并把游标清零', () => {
  const context = fakeContext({ currentTime: 0 })
  const queue = createPlaybackQueue({ contextFactory: () => context })
  const chunk = pcmBase64(new Float32Array(2_400))
  queue.play(chunk, 24_000)
  queue.play(chunk, 24_000)
  assert.equal(queue.playing, true)

  queue.stop()
  assert.equal(queue.playing, false)
  // 游标清零之后，下一句才会立刻开口而不是排在被打断那句的后面等 0.2 秒。
  const next = queue.play(chunk, 24_000)
  assert.ok(next.start < 0.1, `打断后下一句起播太晚：${next.start}`)
})

test('suspended 的 AudioContext 会被叫醒', () => {
  // 浏览器的自动播放策略会把非用户手势里创建的 context 挂成 suspended，
  // 表现是"一切正常但没有声音"。
  const context = fakeContext()
  context.state = 'suspended'
  const queue = createPlaybackQueue({ contextFactory: () => context })
  queue.play(pcmBase64(new Float32Array(240)), 24_000)
  assert.equal(context.resumed, 1)
})

// —— 麦克风采集 ——

function fakeMic() {
  const context = fakeContext({ sampleRate: 48_000 })
  let processor = null
  context.createMediaStreamSource = () => ({ connect() {} , disconnect() {} })
  context.createScriptProcessor = () => {
    processor = { onaudioprocess: null, connect() {}, disconnect() {} }
    return processor
  }
  const tracks = [{ stopped: false, stop() { this.stopped = true } }]
  const mediaDevices = {
    calls: [],
    async getUserMedia(constraints) {
      this.calls.push(constraints)
      return { getTracks: () => tracks }
    },
  }
  return { context, mediaDevices, tracks, feed: samples => processor.onaudioprocess({
    inputBuffer: { getChannelData: () => samples },
  }) }
}

test('采集时申请回声消除，并把 48k 重采样到目标采样率', async () => {
  const rig = fakeMic()
  const chunks = []
  const mic = createMicrophoneStream({
    mediaDevices: rig.mediaDevices,
    contextFactory: () => rig.context,
    onChunk: audio => chunks.push(audio),
    targetRate: 16_000,
  })
  await mic.start()

  // 免提通话必须开回声消除，否则模型会听见自己刚说的话并当成客户在讲。
  assert.equal(rig.mediaDevices.calls[0].audio.echoCancellation, true)

  rig.feed(new Float32Array(2_400))
  assert.equal(chunks.length, 1)
  // 48k → 16k：2400 帧变 800 帧，PCM16 是 1600 字节。
  assert.equal(decodePcm(chunks[0]).length, 800)
})

test('服务端指定的采样率会被采用', async () => {
  const rig = fakeMic()
  const chunks = []
  const mic = createMicrophoneStream({
    mediaDevices: rig.mediaDevices,
    contextFactory: () => rig.context,
    onChunk: audio => chunks.push(audio),
    targetRate: 16_000,
  })
  await mic.start()
  // voice.ready 告知 24k 时必须跟着改，否则上行是变调的话，
  // 识别结果会莫名其妙地差 —— 而且看起来像"模型不行"。
  mic.setTargetRate(24_000)
  rig.feed(new Float32Array(2_400))
  assert.equal(decodePcm(chunks[0]).length, 1_200)
})

test('停止采集会关掉麦克风轨道', async () => {
  const rig = fakeMic()
  const mic = createMicrophoneStream({
    mediaDevices: rig.mediaDevices,
    contextFactory: () => rig.context,
    onChunk: () => {},
  })
  await mic.start()
  assert.equal(mic.active, true)
  mic.stop()
  // 【必须真的 stop track】只 disconnect 节点的话浏览器标签上那个
  // 录音红点会一直亮着，用户以为还在被录音。
  assert.equal(rig.tracks[0].stopped, true)
  assert.equal(mic.active, false)
})

test('麦克风初始化重入只申请一份流', async () => {
  const rig = fakeMic()
  const mic = createMicrophoneStream({
    mediaDevices: rig.mediaDevices, contextFactory: () => rig.context, onChunk() {},
  })
  await Promise.all([mic.start(), mic.start()])
  mic.stop()
  assert.equal(rig.mediaDevices.calls.length, 1)
  assert.equal(rig.tracks[0].stopped, true)
})

test('授权返回之前挂断，迟到的流立即关闭且不创建音频节点', async () => {
  let grant
  let stopped = 0
  const mic = createMicrophoneStream({
    mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve }) },
    contextFactory: () => assert.fail('挂断后不能创建音频上下文'),
    onChunk() {},
  })
  const starting = mic.start()
  mic.stop()
  grant({ getTracks: () => [{ stop() { stopped += 1 } }] })
  assert.equal(await starting, false)
  assert.equal(stopped, 1)
  assert.equal(mic.active, false)
})

test('旧授权迟到不覆盖新一轮麦克风', async () => {
  const rig = fakeMic()
  let grantOld
  let calls = 0
  let oldStopped = false
  const mic = createMicrophoneStream({
    mediaDevices: { getUserMedia: () => ++calls === 1
      ? new Promise(resolve => { grantOld = resolve })
      : rig.mediaDevices.getUserMedia({}) },
    contextFactory: () => rig.context, onChunk() {},
  })
  const old = mic.start()
  mic.stop()
  await mic.start()
  grantOld({ getTracks: () => [{ stop() { oldStopped = true } }] })
  await old
  assert.equal(oldStopped, true)
  assert.equal(mic.active, true)
  assert.equal(rig.tracks[0].stopped, false)
  mic.stop()
  assert.equal(rig.tracks[0].stopped, true)
})

test('创建采集节点失败时释放已获得的麦克风', async () => {
  const rig = fakeMic()
  const mic = createMicrophoneStream({
    mediaDevices: rig.mediaDevices,
    contextFactory() { throw new Error('音频设备不可用') }, onChunk() {},
  })
  await assert.rejects(mic.start(), /音频设备不可用/)
  assert.equal(rig.tracks[0].stopped, true)
  assert.equal(mic.active, false)
})

// ── 播放进度回报 ─────────────────────────────────────────────
// 【这一组守的是一条完整数据链，不是"通知网关一下"】
// 网关把客服的转写压在 pendingTranscripts 里，等的就是 playback.started；
// 收到才 flush，flush 里才调 conversationSync.record 落库。
// 客户页最初漏了这三条回报，实测的表现是：客服声音正常播出，但
// /api/conversations/:id/messages 里【一条 assistant 都没有】——
// 页面上只看得到客户说了什么，出口审计也没有原话可审。

// 一句话的 base64 片段，内容无所谓，只要能解出样本。
const CHUNK = pcmBase64(new Float32Array([0.1, -0.1, 0.2, -0.2]))

function recordingQueue(context) {
  const events = []
  const queue = createPlaybackQueue({
    contextFactory: () => context,
    onStarted: id => events.push(['started', id]),
    onEnded: id => events.push(['ended', id]),
    onCancelled: (id, started) => events.push(['cancelled', id, started]),
  })
  return { queue, events }
}

test('音频暂停或播放时钟未到时，不能提前确认起播', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = fakeContext()
  context.state = 'suspended'
  const { queue, events } = recordingQueue(context)
  t.after(() => queue.close())
  const { start } = queue.play(CHUNK, 24_000, 'paused')
  t.mock.timers.tick(100)
  assert.deepEqual(events, [])
  context.state = 'running'
  t.mock.timers.tick(100)
  assert.deepEqual(events, [])
  context.currentTime = start
  t.mock.timers.tick(100)
  assert.deepEqual(events, [['started', 'paused']])
})

test('暂停期间取消后不再等待或回报起播', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = fakeContext()
  context.state = 'suspended'
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'cancel-before-start')
  queue.stop()
  context.currentTime = 1
  context.state = 'running'
  t.mock.timers.tick(100)
  assert.deepEqual(events, [['cancelled', 'cancel-before-start', false]])
})

test('一句话的多个音频片只回报一次 playback.started', async () => {
  const context = fakeContext({ currentTime: 0 })
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'resp-1')
  queue.play(CHUNK, 24_000, 'resp-1')
  queue.play(CHUNK, 24_000, 'resp-1')
  // 推进音频时钟后再等定时器；只推进墙钟不能代表真正起播。
  context.currentTime = 0.03
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(events, [['started', 'resp-1']],
    '同一句话回报了多次 started，网关会重复 flush')
})

test('audio.done 之前不报 ended —— 后半句还没播', () => {
  const context = fakeContext({ currentTime: 0 })
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'resp-2')
  // 第一片播完了，但网关还没说这句发完 —— 此时报 ended 就等于
  // 告诉网关"客户听完了"，而后半句还在路上。
  context.sources.at(-1).onended()
  assert.equal(events.filter(([kind]) => kind === 'ended').length, 0,
    '音频还没发完就报了 ended')

  queue.play(CHUNK, 24_000, 'resp-2')
  queue.markDone('resp-2')
  assert.equal(events.filter(([kind]) => kind === 'ended').length, 0,
    '还有片子没播完就报了 ended')
  context.sources.at(-1).onended()
  assert.deepEqual(events.filter(([kind]) => kind === 'ended'), [['ended', 'resp-2']])
})

test('被打断的那一句要报 cancelled，否则网关一直等它结束', () => {
  const context = fakeContext({ currentTime: 0 })
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'resp-3')
  queue.stop()
  const cancelled = events.filter(([kind]) => kind === 'cancelled')
  assert.equal(cancelled.length, 1, '打断后没有销账，网关那份上下文回收不掉')
  assert.equal(cancelled[0][1], 'resp-3')
})

test('已经报过 ended 的句子不会再被 stop 报一次 cancelled', () => {
  const context = fakeContext({ currentTime: 0 })
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'resp-4')
  queue.markDone('resp-4')
  context.sources.at(-1).onended()
  queue.stop()
  assert.equal(events.filter(([kind]) => kind === 'cancelled').length, 0,
    '正常结束的句子又被报了 cancelled，网关会把它当成客户打断')
})

test('onended 是"已开始"的兜底 —— 后台标签页里定时器会被节流', () => {
  const context = fakeContext({ currentTime: 0 })
  const { queue, events } = recordingQueue(context)
  queue.play(CHUNK, 24_000, 'resp-5')
  // 不等定时器，直接让它播完：真实浏览器在后台标签页会把 setTimeout
  // 拖到几秒后甚至不触发，而音频线程照常渲染完。
  context.sources.at(-1).onended()
  assert.deepEqual(events.filter(([kind]) => kind === 'started'), [['started', 'resp-5']],
    '定时器被节流时 started 就发不出去了，转写永远不落库')
})
