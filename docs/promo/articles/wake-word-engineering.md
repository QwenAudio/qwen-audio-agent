# 本地语音唤醒词的工程实现：让 Agent 睡着也能被叫醒

> 桌面语音助手休眠后，麦克风保持开启，说出"你好千问"即可唤醒。
> 本文讲 qwen-audio-agent 中这套唤醒词链路的工程实现与踩坑。

## 需求：休眠不是关机

语音助手有一个矛盾：为了省电和隐私，空闲时应该"睡着"
（断开实时语音连接、停止大模型推理）；但用户期望随时开口就能叫它。

解法是**本地唤醒词（Keyword Spotting）**：休眠期间只跑一个极小的
本地模型监听麦克风，检测到唤醒词后再唤醒整个会话链路。
全程本地推理，无云端调用，隐私和延迟都可控。

## 状态机：SleepController

休眠/唤醒的状态管理被刻意做成了一个 80 行的小类
（`server/src/voice/sleep-controller.mjs`），核心逻辑：

```js
export class SleepController {
  constructor({ timeoutMs, retryMs, canSleep, onSleep }) { /* ... */ }

  recordActivity() {        // 任何用户活动重置休眠倒计时
    if (!this.enabled || this.sleeping || this.closed) return
    this.schedule(this.timeoutMs)
  }

  async trySleep() {        // 倒计时结束，先问"现在能睡吗"
    if (!this.canSleep()) {
      this.schedule(this.retryMs)  // 不能睡就稍后重试
      return
    }
    this.sleeping = true
    await this.onSleep()
  }

  wake() { /* 唤醒并重置活动计时 */ }
}
```

三个关键设计：

1. **`canSleep` 守卫**：Agent 正在说话、任务刚完成等待追问、权限请求
   未确认时不能休眠。"能不能睡"的判断权在业务层，状态机只管调度。
2. **重试而非放弃**：不能睡就 `retryMs` 后再试，避免一次错过就永远不休眠。
3. **唤醒即活动**：`wake()` 会重置计时器，唤醒后的交互窗口内不会
   再次立刻休眠。

此外还有任务通知唤醒：后台任务完成或出现权限请求时，
即使处于休眠也会被主动唤醒播报——"睡着"只是降低资源占用，
不是失联。

## 检测引擎：sherpa-onnx

唤醒词检测用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
的 Keyword Spotting，模型是 3M 参数的中英 transducer
（`sherpa-onnx-kws-zipformer-zh-en-3M`），CPU 单线程即可实时运行。

`server/src/voice/wake-word/sherpa-detector.mjs` 里的关键配置：

```js
const keywordSpotter = createKws({
  featConfig: { samplingRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder, decoder, joiner },
    tokens, numThreads: 1, provider: 'cpu',
    modelingUnit: 'cjkchar',       // 中文按字建模
  },
  maxActivePaths: 4,               // 越小越省 CPU
  numTrailingBlanks: 1,
  keywordsScore: 1.0,
  keywordsThreshold: 0.25,         // 灵敏度权衡点
  keywordsBuf: keywords,           // 关键词文件以 buffer 传入
})
```

检测循环是流式的：音频按块 `acceptWaveform`，`decode` 到就绪，
`getResult` 命中关键词就触发唤醒并 `reset` 流状态。

### 踩坑：WASM 下的关键词文件

sherpa-onnx 的 WASM 构建无法把宿主机文件路径透传给原生的
`keywords_file` 字段。解决办法是绕开虚拟文件系统：
把本地校验过的关键词文件读成 buffer，用 `keywordsBuf` 传入。
这样关键词加载与 WASM 文件系统完全解耦。

## 模型分发：下载 + SHA256 校验

模型不随 npm 包分发（体积原因），首次使用时按需下载
（`model-manager.mjs`）：

- 从 sherpa-onnx 官方 release 下载 `tar.bz2` 模型包；
- **下载后强制校验 SHA256**，不匹配直接拒绝，防止模型被替换；
- 解压后校验所有必需文件齐全（encoder/decoder/joiner/tokens/keywords）；
- 写入完成用原子 rename，避免半成品目录被误用；
- 引擎按模型目录做单例缓存，多会话共享一个引擎。

## 效果与调参经验

- `keywordsThreshold` 是误唤醒和漏唤醒的权衡点，0.25 是我们在
  普通办公室环境下的折中值；
- `maxActivePaths` 从默认值降到 4，CPU 占用显著下降，
  对固定唤醒词的识别率几乎无影响；
- 唤醒词模型和对话 ASR 完全分离——唤醒只用 3M 模型常驻，
  重模型只在唤醒后启动，这是休眠方案能成立的前提。

---

qwen-audio-agent 是开源项目（Apache-2.0），唤醒词功能已在桌面版上线。
仓库：https://github.com/QwenAudio/qwen-audio-agent
