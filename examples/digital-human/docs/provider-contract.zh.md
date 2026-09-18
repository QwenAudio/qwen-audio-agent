# DigitalHumanProvider 契约草案

状态：待评审，接口尚未实现。与 [架构设计](design.zh.md) 一起阅读。本文是框架契约，不是某一家厂商的 SDK 镜像。

## 1. 用两个具体实现校验边界

| 项目 | OpenAvatarChat / FlashHead Avatar | LiveAvatar Avatar Only / LITE |
| --- | --- | --- |
| 接入对象 | Python Avatar 组件，需要薄服务适配 | 已有音频驱动的云服务 API |
| 输入语义 | 已生成的助手回复音频 | 已生成的助手回复音频 |
| 输入传输 | example 的私有协议 | 厂商 WebSocket 事件 |
| 文本 | 当前 FlashHead 路径不要求文本 | 此处采用的 LITE 音频事件不要求文本 |
| 媒体输出 | 视频帧及配对的原始音频 | 经其实时媒体基础设施接收 |
| 对话能力 | 不加载 ASR/LLM/TTS 链路 | 不选择 FULL 模式或托管对话 connector |

上述差异意味着：控制 SPI 与媒体连接适配要分开；不把 `RTCPeerConnection`、LiveKit Room、NumPy 或厂商事件字段塞进核心接口。

## 2. 输入和能力

公共输入采用带描述的音频块，不能由变量名猜采样率。首版适配器统一支持 PCM16 little-endian、24 kHz、单声道。网关输出不同格式时由有状态转换器适配，不能每个 chunk 独立重采样。

```ts
type AudioFormat = {
  encoding: 'pcm_s16le';
  sampleRate: number;
  channels: 1;
};

type TurnRef = {
  avatarSessionId: string;
  responseId: string;
  generation: number;
};

type Capabilities = {
  version: 1;
  streamingAudio: true;
  inputAudioFormats: AudioFormat[];
  textInput: 'none' | 'optional';
  interrupt: boolean;
  idle: boolean;
  outputModes: Array<'paired_av' | 'video_with_audio_timeline'>;
};
```

`sampleOffset` 以协商后的输入采样率计，是本轮已提交的每声道样本位置；首块为 0。PCM 长度必须对齐整帧。文本序号与音频序号独立，不假设一段文本恰好对应一个音频块。

只接收完整文本而无法消费流式回复音频的服务不满足首版契约，应使用另一类适配，而不是悄悄等整句生成完。

## 3. 拟议 SPI

```ts
interface DigitalHumanProvider {
  capabilities(): Promise<Capabilities>;
  openSession(input: {
    persona: TrustedPersona;
    format: AudioFormat;
    signal: AbortSignal;
  }): Promise<DigitalHumanSession>;
}

interface DigitalHumanSession {
  readonly avatarSessionId: string;
  readonly mediaBinding: MediaBinding;

  startTurn(ref: TurnRef): Promise<void>;
  appendAudio(input: TurnRef & {
    sequence: number;
    sampleOffset: number;
    data: Uint8Array;
  }): Promise<void>;
  appendText?(input: TurnRef & {
    sequence: number;
    delta: string;
  }): Promise<void>;
  finishTurn(input: TurnRef & {
    lastAudioSequence: number;
    totalSamples: number;
  }): Promise<void>;
  interruptTurn(input: TurnRef & {
    reason: CancelReason;
  }): Promise<void>;
  events(): AsyncIterable<DigitalHumanEvent>;
  close(): Promise<void>;
}
```

`TrustedPersona` 是启动配置解析后的只读配置，不是客户端提交的任意对象；只包含渲染配置，不包含对话提示词。`MediaBinding` 和事件结构在下文定义。以上类型是说明性伪代码，不是可直接导入的 SDK。

约束：

- 一次 session 首版只允许一个非终态 turn，音频按顺序追加。
- `appendAudio` resolve 表示进入有界接收队列，不表示已推理或已播放。
- 编排器也必须有界，不能把无穷多个 pending Promise 当成背压。
- 完成输入后不得再追加；没有音频的响应不应创建一个假说话片段。
- 重复 finish/cancel/close 幂等；相同序号不同内容报协议错，重复相同内容可以忽略，序号缺口失败。
- close 和 cancel 优先于积压的音频输入，不能排在慢推理之后永久等待。
- `generation` 由网关控制，Provider 输出必须保留它；内部厂商 ID 不能代替它。
- 不支持 interrupt 的实现不得在首版中伪装成支持实时打断的 Provider。

## 4. 生命周期事件与终态

| 事件 | 意义 |
| --- | --- |
| `session.ready` | 控制和媒体入口均可用，允许开始 turn |
| `turn.first_media` | 可发布的首个媒体单元已产生，不表示用户已经看到/听到 |
| `turn.completed` | Provider 不会再产生本轮媒体；媒体队列仍可能未播放完 |
| `turn.cancelled` | Provider 接受取消或本地适配器已隔离旧代次 |
| `provider.error` | 会话或 turn 失败，包含错误类别和是否允许重建 |

所有 turn 事件都带 `TurnRef`。输出流失效、协议错误、容量不足、首帧超时、媒体停滞应能区分；对外日志不能包含音频正文、密钥或整个私有 URL。

建议错误码：`unavailable`、`capacity_exhausted`、`invalid_media`、`first_media_timeout`、`media_stalled`、`protocol_error`。供应商原始错误保留在脱敏诊断，不成为公共稳定契约。

建议取消原因：`user_interruption`、`content_safety`、`permission_revoked`、`owner_replaced`、`provider_failure`、`transport_lost`、`session_closed`。

用户打断与 Provider 故障不能都映射成 `user_interruption`。前者可能确认用户主动略过播报，后者不等价；映射到现有历史/任务播报状态时必须保留原因。

## 5. 媒体接口与时间轴

### 5.1 媒体连接不是客户端响应

`MediaBinding` 是内部描述：媒体适配器 ID、作用域有限的连接句柄、协商后的格式和协议版本。私有 URL/token 不放入公共 `session.created` 或浏览器日志。

媒体适配器由可信启动注册表选择，加载在 Media Worker 中，提供 open/read/clear/close 语义，并将厂商输出归一化为媒体单元。其依赖从 example 包解析，不依赖主框架的偶然 hoisting。

首版采用 `paired_av`：Provider 返回配对的音频和视频。`video_with_audio_timeline` 仅为未来能力，必须明确如何关联网关保留的原音频，不能宣称它已实现。

### 5.2 规范化媒体单元

一个 `MediaUnit` 至少包含 `TurnRef`、递增 `sequence`、`ptsUs`、`durationUs`、音频格式和样本范围、视频格式/尺寸及二进制负载。对应静默段和 idle 要显式标记，不能冒充回复音频。

- turn-local 时间从输入采样位置派生，不能用消息到达时间充当唇形时间戳。
- 一个样本范围只能播放一次；padding 要标识，不能计入真实输入覆盖范围。
- 网关发布时把 turn-local 时间映射到持续的 session 媒体时钟；新回复不能重置 RTP 时间轴。
- 音频和视频必须在同一个受控播放时间基准上调度，不能各自按收到时间立即发出。
- idle 视频不占用某轮回复的语义，但底层媒体时钟继续推进。
- 取消后尚未提交的媒体丢弃；下一轮使用新代次，不允许旧 mouth motion 回流。

当前原生 WebRTC API 是否允许足够精确的时间控制，应先用确定性媒体验证。DataChannel 消息顺序不等于 RTP 播放顺序；不得仅靠收到 `turn.first_media` 就发送用户端播放回执。

### 5.3 三层完成与取消状态

| 状态 | 负责方 |
| --- | --- |
| 输入封口、模型生成完成 | 对话运行时 / Provider 输入适配 |
| 媒体生成结束、发送队列排空 | Provider / Media Worker |
| 播放开始、结束或取消 | 客户端观测，经网关校验 |

输出选择器状态建议为 `BUFFERING -> COMMITTED_AVATAR | COMMITTED_AUDIO -> DRAINING -> TERMINAL`，任一非终态可进入 `CANCELLED`。`finishTurn` 不会直接把状态变成 `TERMINAL`。

首包发布是不可回退的 commit 点。只有在 commit 前的基础设施失败可转 `COMMITTED_AUDIO`；同轮不能先 commit avatar 再从头播 fallback。取消和切换输出的代次在主进程与 Media Worker 间需要显式 ACK/隔离，禁止两个出口竞争。

## 6. OpenAvatarChat 的具体映射

基于 [FlashHead Handler](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/avatar_handler_flashhead.py) 和 [Processor](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/flashhead_processor.py) 的现有职责，建议映射如下：

| SPI | 适配行为 |
| --- | --- |
| openSession | 加载白名单头像，创建隔离的 Processor 和媒体回调 |
| startTurn | 创建新的推理作业上下文，绑定 response/generation 与 speech ID |
| appendAudio | 24 kHz PCM 解码，保留原音频；有状态重采样为推理输入后送 `add_audio` |
| finishTurn | 封口输入并 flush；处理补齐帧和没有残留数据的终止标记 |
| interruptTurn | 调用 interrupt，失效当前作业和待发布媒体 |
| 媒体回调 | 将图像及配对音频转为带时间和样本范围的媒体单元 |

这不是现成的稳定远程 API，必须封装 Renderer。Python 适配器应复用上游推理、窗口和收集器逻辑，不复制一份 FlashHead 算法。

## 7. LiveAvatar LITE 的具体映射

参考 [官方 LITE 事件](https://docs.liveavatar.com/docs/lite-mode/events)。其命令通过会话 WebSocket 发送，输入为 Base64 PCM16/24 kHz/mono。

| SPI | LITE 适配行为 |
| --- | --- |
| openSession | 通过服务端 API 建立 LITE 会话，等待连接就绪并建立媒体订阅 |
| startTurn | 本地分配本轮 UUID，准备与网关 response/generation 的映射 |
| appendAudio | 编码为 `agent.speak`，首块 event ID 用作本轮厂商 utterance ID |
| finishTurn | 发送 `agent.speak_end`，封口，不当作客户端已播完 |
| interruptTurn | 发送 `agent.interrupt`，立即在本地隔离旧代次 |
| 事件关联 | 将 `source_event_id` 还原为 TurnRef；取消命令的 ID 单独关联 ACK |

Provider 的 speak 状态只描述厂商侧状态，不能直接作为网关客户端播放证明。厂商媒体轨道通常不逐帧携带网关的 generation，媒体适配器需要安全的刷新/重订阅边界；无法证明旧缓冲已隔离时应重建流，而非给残留帧贴新 ID。

LiveAvatar 接入现有 LiveKit/Agora 等媒体设施，不意味着可以把一个通用 SDP 地址直接交给现有网关。未来实接需要单独的媒体 Adapter 和契约验收，不承诺只换 API Key 即可工作。本轮只做映射和模拟契约测试，不安装 SDK、不创建收费会话。

## 8. 接口兼容性验收

- Mock、OpenAvatarChat 以及模拟的 LITE 事件适配，使用相同的输入生命周期测试向量。
- 改变 Provider 不改变客户端协议、owner/session 或 Realtime 适配器。
- 不要求 Provider 接收用户麦克风，不要求 Provider 返回对话文本。
- 音频核心接口不以 WebSocket、WebRTC 或 Python 类型命名。
- 未声明 text 能力时不调用文本输入，也不等待文本。
- 声称支持的媒体模式、格式和取消语义必须经过测试，不能只通过类型检查。
