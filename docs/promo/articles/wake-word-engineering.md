# 本地语音唤醒词的工程实现：让 Agent 睡着也能被叫醒

> 桌面语音助手休眠后，麦克风保持开启，说出唤醒词即可唤醒。
> 本文讲 qwen-audio-agent 中这套唤醒词链路的工程实现与踩坑。

## 需求：休眠不是关机

语音助手有一个矛盾：为了避免环境误输入，空闲时应该隐藏界面并停止向
Realtime 发送麦克风音频；但用户仍期望随时开口就能叫它。

解法是**本地唤醒词（Keyword Spotting）**：休眠期间只跑一个极小的
本地模型监听麦克风，检测到唤醒词后再恢复客户端 Presence 和输入链路。
全程本地推理，无云端调用，隐私和延迟都可控。

## 边界：唤醒属于桌面客户端

麦克风、窗口、快捷键和本地唤醒都属于 Client Environment。桌面 Renderer
只在隐藏状态把 16 kHz 音频交给 Electron 主进程；主进程在独立 Worker 中运行
检测器，命中后显示窗口，并通过 Gateway Client Protocol 发送标准 `wake` 事件。
Gateway 不加载唤醒模型，也不接收唤醒词音频。

```text
Microphone → Desktop Renderer → Desktop KWS Worker
                                      ↓ detected
Desktop Presence ← Electron Main → GCP wake → Gateway
```

三个关键设计：

1. **音频不越界**：休眠音频只进入客户端 Worker，不发送给 Gateway 或云端。
2. **推理不阻塞 UI**：sherpa-onnx 不在 Electron 主线程执行。
3. **会话不重建**：休眠保留 Realtime Session；唤醒只恢复 Presence 和输入，
   后台任务、对话上下文和待播报结果保持原状。

## 检测引擎：sherpa-onnx

唤醒词检测用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
的 Keyword Spotting，模型是 3M 参数的中英 transducer
（`sherpa-onnx-kws-zipformer-zh-en-3M`），CPU 单线程即可实时运行。

`desktop/src/wake-word/sherpa-detector.mjs` 里的关键配置：

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
