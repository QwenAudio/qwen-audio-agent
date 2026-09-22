# Gateway Client Protocol

> 状态：**Stable 7.0**<br>
> 线协议版本：**7.0.0**<br>
> Roadmap：[GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)<br>
> 当前实现事实源：`shared/protocol/gateway-client-protocol.mjs`、`server/src/client/client-event-router.mjs`、`server/src/client/client-command-runtime.mjs`、`shared/protocol/realtime-events.mjs`、`shared/protocol/gateway-events.mjs` 与 `server/src/core/gateway-protocol.mjs`

本文档定义 qwen-audio-agent Gateway 与每个已认证用户的一个活动 Client Environment 之间已经落地的北向协议。当前第一方客户端使用 7.0 线协议；旧 `connect` 与运行时 REST 入口仍作为兼容别名保留，不用于新客户端接入。健康契约与线协议独立版本化，见[Gateway 契约](contract.zh.md)。

## 1. 产品边界

核心逻辑架构是**前台 Agent、编排运行时、后台 Agent**。本协议定义客户端如何接入服务，不改变这三个组件的划分，详见[架构总览](architecture/overview.zh.md)。

- **前台 Agent** 通过实时模型、上下文和工具理解输入、组织回复。
- **编排运行时** 管理任务、权限、会话、事件路由、结果投递与恢复，通过 `BackendPort` 对接后台。
- **后台 Agent** 是用户提供的执行环境，ACP、A2A 或自定义 Adapter 实现其接入。

**Gateway** 是承载运行时与前后台接入的服务宿主，提供认证、连接管理和本协议入口。**Client Environment** 负责 I/O、显示、播放、本地 UX、传感器、用户行为和环境动作，通过本协议与 Gateway 通信。下文的“Gateway 处理”包含其承载的运行时行为，不表示把业务逻辑放进传输层。

TUI、WebUI 和桌面悬浮球是第一方参考客户端；OpenCode、Qwen Code、MiniMax Code、Pi、OpenClaw、远程 A2A Agent 等是参考后台。两者都不限制框架可接入的实现。

## 2. 架构不变量

1. 每个已认证用户同一时刻只有一个活动 Client 连接。默认个人部署只有一个用户，因此仍表现为单 Client。
2. Client 的业务流量使用一条 WebSocket，不额外建立 context 或 observer 连接。
3. 原始音频走媒体快速路径，只有已经提交的语义输入进入语义路由。
4. Client **Event** 描述发生了什么；Client **Action** 要求环境执行操作并返回结果。
5. Realtime Tool Call 是模型接口；适用的 Tool Call 由 `ClientActionPort` 映射为 Client Action。
6. Gateway 决定事件是确定性处理、只进入模型上下文、稍后回复还是立即回复。
7. Client Event 不能伪造 Gateway、Task、权限或后台生命周期事件。
8. Realtime Provider 与后台协议的原生协议对象不能跨越本边界。所有公开类型由 Gateway 定义；语义一致时，可以刻意对齐外部标准中熟悉的字段命名和形状。
9. 本地静音、窗口布局、唤醒手段和渲染属于 Client；只有影响共享状态的部分进入协议。
10. 在全部第一方客户端完成迁移并具备 conformance coverage 前，现有行为通过兼容别名继续可用。

### 2.1 访问边界

Gateway 访问认证与 GCP 明确分层。访问凭据在 `session.hello` 之前完成身份认证；
访问令牌不会进入 GCP 信封、模型上下文、Task 事件或日志。

- 本机回环访问继续保持零配置，Gateway 默认仍只监听 `127.0.0.1`。
- 显式 `--lan` 模式监听 `0.0.0.0`，但仅发布自动选择的物理网卡 IPv4 `ws://` Endpoint；
  该模式只面向可信局域网，不支持直接暴露到公网。
- 远程 HTTP 与 WebSocket 必须使用配置的访问密钥，或网关主机签发的可撤销设备令牌。
- 原生 Client 在 WebSocket 握手使用 `Authorization: Bearer <token>`；浏览器通过 WebSocket 子协议携带同一 Token。
- 远程浏览器来源必须显式写入 `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS`。远程部署应使用可信 VPN 或 HTTPS/WSS 反向代理，不支持直接暴露到公网。
- 一个配置密钥映射一个用户；可选的 `QWEN_AUDIO_AGENT_ACCESS_KEYS` JSON 数组可把不同密钥映射到不同用户，而无需修改 GCP。

本机操作者可对运行中的 Gateway 执行 `qwenaudio gateway pair`，直接生成一个包含准确
Gateway 地址与可撤销设备令牌、并可直接打开 WebUI 的短浏览器兼容连接码。
设备令牌只以 SHA-256 摘要持久化，明文凭据只显示一次；原生远程 Client 不需要再通过
HTTPS 换取 Token。浏览器扫码页仅把 fragment 中的 Token 换成 HttpOnly Cookie。本机管理
接口可列出和撤销设备。
旧版一次性配对接口仍作为兼容路径保留。

端点发布、设备连接码签发与设备管理等 Host 管理请求不属于交互式 GCP Session。
它们独立完成认证，也不会取得或替换活动 Client 租约。

## 3. 连接与能力协商

Client 连接 `ws://<gateway>/api/realtime`，第一条消息必须是 `session.hello`。

```jsonc
{
  "type": "session.hello",
  "event_id": "evt_client_1",
  "protocol": { "min": "7.0.0", "max": "7.0.0" },
  "client": {
    "type": "desktop",
    "version": "1.12.0",
    "instance_id": "desktop_7f3a"
  },
  "capabilities": [
    "input.audio",
    "input.text",
    "input.image",
    "playback.receipts",
    "tasks.commands",
    "permissions.respond",
    "conversation.history",
    "client.events",
    "session.output_voice",
    "session.takeover",
    "session.heartbeat",
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ],
  "locale": "zh-CN",
  "time_zone": "Asia/Shanghai",
  "connection": {
    "voice_enabled": true,
    "input_enabled": true,
    "output_enabled": true,
    "text_only": false,
    "output_voice": "longanlufeng"
  }
}
```

`connection.output_voice` 是可选的会话级输出音色偏好。Gateway 将它交给当前
Realtime Provider 解释；不设置时继续使用 Provider 的部署级默认音色。对于仅允许在
首次会话配置音色的 Provider，Gateway 在运行时切换时只重建上游 Provider Session；
客户端 GCP 连接与 Gateway 会话保持不变。

Gateway 返回协商后的版本与能力交集：

```jsonc
{
  "type": "session.ready",
  "event_id": "evt_gateway_1",
  "request_event_id": "evt_client_1",
  "protocol_version": "7.0.0",
  "session_id": "session_01",
  "connection": {
    "lease_generation": 7,
    "replaced": false
  },
  "capabilities": [
    "input.audio",
    "input.text",
    "input.image",
    "playback.receipts",
    "tasks.commands",
    "permissions.respond",
    "conversation.history",
    "client.events",
    "session.output_voice",
    "session.takeover",
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ]
}
```

规则：

- 同一用户已有活动 Client 时，另一个 Client 默认收到 `client_occupied` 后关闭。
- 协商了 `session.takeover` 的 Client 可在 `session.hello` 中设置 `connection.takeover: true`。Gateway 会关闭原 Client，并授予单调递增的新租约代次。
- 相同 `client.instance_id` 的重连无需显式接管，会自动替换旧 Socket。
- 不同用户彼此独立，但每个用户仍只有一个活动 Client。
- WebSocket 关闭或心跳超时后释放租约；租约代次 fencing 会阻止旧 Socket 释放或修改新租约。
- 协商了 `session.heartbeat` 的 Client 必须使用关联的 `session.pong` 回复 Gateway 的每个 `session.ping`；正常业务消息同样会续租。这避免依赖某些反向代理无法可靠保留的 WebSocket 控制帧。
- 7.0 不提供 Observer 连接或同一用户下的并发多 Client 控制。
- Client 必须依据协商后的 capabilities 判断能力，不能只比较产品版本。
- 协议版本、Client 身份和能力不能在当前连接中改变；需要改变时重连。
- 7.0 不定义 `context_source`、`integration` 或 Observer 连接角色。车辆总线、CRM、传感器等上下文来源通过客户端侧 Adapter 接入当前活动 Client Environment，再由该 Client 校验并转发信息事件。

### 3.1 GCP1 兼容落地

GCP1 在不分叉 Gateway 业务逻辑的前提下实现信封与握手。当前 7.0 Client 以
`session.hello` 开始；Gateway 返回 `session.ready`，为后续下行事件补充
`event_id`，并把协议输入归一化到现有内部事件模型。旧 5.x Client 仍可使用
`connect`，收到的旧事件形状保持不变。握手只协商已有运行时实现的能力。GCP2 的
Client Event 与运行时命令 capability、GCP3 Agent Delivery、GCP4 Client Action
以及 GCP5 参考 Client 与有限回放均已实现。

### 3.2 GCP2 运行时落地

GCP2 在协商后的同一条 WebSocket 上实现 `client.event.publish`，以及第 5.4 节的
Task、权限和对话历史命令。即时结果与错误通过 `request_event_id` 关联。现有 REST
路由调用同一个 Runtime Command Service，并暂时作为兼容别名保留。

普通 Client 信息事件携带文本和投递方式，不要求预注册。只有需要确定性处理的宿主扩展才注册事件定义。身份由已认证连接提供，业务操作与信息投递分离。详见第 5.2、5.3 节。

### 3.3 GCP3 Delivery 落地

GCP3 实现第 6 节定义的 Provider 无关值与四种路由模式。Task 最终结果、有意义的低频
进展、权限请求和Client Event 投影统一进入 `RealtimeAgentDeliveryRuntime`。
Realtime Provider 只编码最终的上下文项与可选回复；Client 或后台协议原始对象不会
进入模型。现有 Task 播报的批处理、安全窗口重试、通知认领和播放确认继续作为这条共享
投影外围的可靠生命周期。

### 3.4 GCP4 Client Action 落地

GCP4 实现有关联关系的 `client.action.request/result` 和协议无关的
`ClientActionPort`。当前桌面端在握手时提供自己的工具目录。客户端空闲策略、实际状态
同步和模型可见信息各走自己的边界，详见第 7 节。宿主扩展仍可提供自定义动作。

### 3.5 GCP5 参考 Client 与回放落地

GCP5 发布共享 `GatewayClient` SDK，统一处理握手、命令关联、Client Action、断线重连
和状态恢复。WebUI、Desktop 与 TUI 使用同一 capability profile 和一致性测试。Task
生命周期推送携带 Session 内递增的 `sequence`，`session.replay` 有界回放断线前未消费
的事件；随后通过同一 WebSocket 的 `task.list` 与 `conversation.history` 恢复断线期间
可能变化的最终快照。媒体增量、临时转写和即时命令结果不回放。

健康契约 `5.5.0` 起，`connect` 以及 Task、权限、对话历史和 Session 回放的 REST
路径成为废弃兼容别名，且不会早于健康契约 `6.0.0` 删除。

## 4. 通用事件信封

Gateway 采用扁平的 OpenAI Realtime 风格信封：

```jsonc
{
  "type": "client.event.publish",
  "event_id": "evt_client_42",
  "name": "user.object.touched",
  "text": "用户触摸了水杯。"
}
```

| 字段 | 要求 | 语义 |
|---|---|---|
| `type` | 始终必填 | 协议事件类型 |
| `event_id` | 每个 JSON 事件 | 稳定的逻辑事件标识；回放保持原值 |
| `request_event_id` | 命令结果与命令错误 | 指向发起命令 |
| `sequence` | 可回放的服务端推送 | 在同一 Gateway Session 内严格递增 |
| `occurred_at` | 已知发生时间的语义事件 | 事件源的毫秒时间戳；Gateway 另记接收时间 |

即时命令结果和错误不回放。媒体增量、转写增量、心跳以及 `session.replay.result` 也不回放。

命名相似是有意为之，但本文定义的 Schema 才是权威契约。复用标准字段名或兼容形状，不代表引入该标准的对象类型，也不宣称线兼容。

所有控制消息使用 UTF-8 JSON 文本帧。7.0 在 JSON 中以 base64 承载 PCM 音频；可选 WebRTC 媒体传输见[WebRTC 客户端](gateway-webrtc-client.zh.md)，不改变语义事件路由。

## 5. 协议面

### 5.1 用户输入与媒体

语义相同时采用 OpenAI Realtime 词汇：

| 事件 | 方向 | 语义 |
|---|---|---|
| `input_audio_buffer.append` | C→G | 追加输入音频 |
| `input_image_buffer.append` | C→G | 向实时视觉缓冲区追加一张 JPEG 帧 |
| `input_image_buffer.clear` | C→G | 丢弃尚未消费的实时视觉帧 |
| `conversation.item.create` | C→G | 提交文本、图片、文件或混合用户输入 |
| `response.cancel` | C→G | 打断当前回复 |
| `response.created` | G→C | 回复开始生成 |
| `response.output_audio.delta` / `.done` | G→C | 音频输出 |
| `response.output_audio_transcript.delta` / `.done` | G→C | 助手转写 |
| `response.done` | G→C | 回复最终状态；取消使用 `response.status = "cancelled"` |

Gateway 扩展包括 `turn.started`、`transcript.discard`、`playback.clear` 和播放回执。`input_file` 是 Gateway content part 扩展，不属于 OpenAI Realtime 标准字段。

用户输入代表明确的用户意图，会开启或替代用户轮次。Client 语义事件不能伪装成用户输入。

`input.image` 与 `input.image_buffer` 是两个独立协商的能力。前者表示
`conversation.item.create` 中绑定回合的图片附件；后者表示与实时音频会话对齐的
临时视觉帧。只有所选 Realtime Provider 的实际传输层已经实现视觉流时，Gateway
才会协商 `input.image_buffer`。

```jsonc
{
  "type": "input_image_buffer.append",
  "event_id": "evt_client_frame_18",
  "occurred_at": 1787803060177,
  "media_type": "image/jpeg",
  "image": "<base64-jpeg>"
}
```

第一版只接受 JPEG，Base64 正文不超过 256 KiB，并且每秒最多接收一帧。视觉帧只
更新实时视觉上下文：不创建用户回合、不主动触发回复、不进入对话历史，也不会成为
后台附件。用户主动停止实时视觉或关闭相机时，Client 发送
`input_image_buffer.clear`，清除尚未消费的帧，但不删除模型已收到的历史画面。
图像缓冲协议不表示摄像头开关。Client 另行通过 `client.event.publish` 上报
`media.visual_input.changed` 环境事件，仅更新模型上下文，不触发回复；不支持上下文
注入的 Provider 跳过该通知。麦克风静音不清除视觉输入。短暂断线暂停
Client 传帧，恢复后继续；Session 断开、休眠、输入抢占和 Provider 切换仍会清除待发送
视觉状态，避免旧帧跨越传输生命周期残留。

该 GCP 事件保持 Provider 无关。Qwen Omni Adapter 在首次图像之前尚无音频时，以
20 毫秒静音初始化音频时间线，无需打开麦克风；MiniCPM-o Adapter 把最近一帧放入下一批音频 `input.append` 的
`video_frames`。

### 5.2 Client 信息事件

环境状态、观察结果或非文字/语音的用户行为，使用 `client.event.publish`。
普通信息无需预注册业务名称：

```json
{
  "type": "client.event.publish",
  "event_id": "evt_visual_1",
  "name": "media.visual_input.changed",
  "text": "摄像头已关闭，之前收到的画面只代表历史，不代表当前环境。",
  "delivery_hint": "context"
}
```

- `type` 选择协议操作；`event_id` 关联回执，并在有限时间内按连接身份去重。
- 此形式必须提供 `text`。`name` 只是可选标签，不决定处理器。即使标签叫
  `task.completed`，也不能更改 Task 或伪造内部事件。
- `delivery_hint` 默认 `context`，只更新上下文；`respond` 安排回复；
  `interrupt` 打断当前回复后请求回复。仍受 Provider 能力、连接和播放策略约束。
- 文本上限 16,000 字符、载荷上限 32 KiB；同一来源的所有标签共用每 10 秒 20 次限额。
  来源身份取自已认证连接，不能由消息自报。
- `client.event.publish.result` 中的 `accepted: true` 只表示网关已接收，
  **不表示模型已经收到或播报**。此接口不是持久化消息队列；连接不可用时投递可能跳过，
  并记录日志。

网关将文本标记为客户端提供的信息，通过 `AgentDelivery` 投递，不把整个信封当成
系统指令，也不直接执行文本里的操作。仅上下文投递不会创建回复。
`respond` / `interrupt` 允许模型回应或调用已有工具，但不会绕过工具权限，
也不会按事件名称直接执行操作。

WebUI 在实际开始采集、停止、失败时上报视觉状态，不逐帧上报。客户端只缓存最新状态，
在 `voice.ready` 后重新投递；`input_image_buffer.clear` 仍是独立的图像缓冲操作。

**宿主扩展：** 需要结构化校验或确定性处理的部署，仍可通过
`createGatewayApplication({ clientEventDefinitions })` 注册扩展。扩展使用
`{name, data}` 形式，不携带 `text`；未知名称拒绝处理。扩展自行定义 Schema、限额、
处理器和模型投影，`delivery_hint` 不能超过注册的最高等级。这是可选扩展路径，
不是普通信息投递的前置条件。混用 `text` 与 `data` 或 `handle` 会被拒绝；
文本事件绝不会触发扩展处理器。

### 5.3 客户端工具

客户端在 `session.hello` 中通过 `client.tools` 能力声明工具：

```json
{
  "capabilities": ["client.tools", "client.presence"],
  "tools": [{
    "name": "enter_sleep",
    "description": "用户要求休息时，隐藏并静音当前客户端。",
    "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
    "response_on_success": "none"
  }]
}
```

以上是握手补充字段。工具定义采用 `name` / `description` / JSON Schema
`inputSchema`；这是 **GCP 的工具发现和传输，不是 MCP Server**。
配置的 MCP 工具仍通过现有标准 MCP 通道调用。

工具目录仅属于当前连接，最多 32 个，不得覆盖网关或配置工具源的同名工具；
断连或接管后，旧客户端工具不再可达。客户端负责校验参数、执行实际操作，
网关负责向模型提供定义，通过已有请求/结果通道转发调用：

```json
{
  "type": "client.action.request",
  "event_id": "evt_call_1",
  "name": "client.tool.enter_sleep",
  "arguments": {}
}
```

```json
{
  "type": "client.action.result",
  "event_id": "evt_result_1",
  "request_event_id": "evt_call_1",
  "status": "completed",
  "output": { "state": "hidden" }
}
```

网关管理能力检查、调用关联、超时和断连错误。失败返回 `failed` 或 `unsupported`，
并附 `error.code/message`。`response_on_success` 默认 `auto`；
设为 `none` 时，成功结果写入工具回执但不创建续答，失败仍触发回复。
工具输出继续使用前台工具的统一大小限制。

宿主工具使用的 `xomni.visual.capture` 等动作继续复用此传输。它们与信息事件
保持独立：`client.event.publish` 不执行客户端动作。

### 5.4 运行时命令与查询

活动 Client 通过同一个 WebSocket 发起运行时命令与查询。每个命令携带 `event_id`；即时 `<command>.result` 通过 `request_event_id` 关联请求。后续生命周期变化仍作为普通服务端推送发布，不能隐藏在命令结果中；Task 生命周期推送由 `session.replay` 有界回放。

| 命令 | 方向 | 语义 |
|---|---|---|
| `task.create` | C→G | 显式创建异步 Task，不伪装成对话中的用户输入 |
| `task.get` / `task.list` | C→G | 查询一个 Task，或读取有界、可筛选的 Task 快照 |
| `task.cancel` | C→G | 请求取消一个 Task；最终状态由后续生命周期事件报告 |
| `permission.respond` | C→G | 处理当前等待中的授权请求 |
| `task.input.respond` | C→G | 把用户补充输入交回同一 Task，或拒绝/取消这次交互 |
| `conversation.history` | C→G | 读取有界、对 Client 安全的对话投影 |
| `session.output_voice.update` | C→G | 更新当前会话的输出音色；结果为 `session.output_voice.updated` |
| `session.replay` | C→G | 从 sequence 游标回放符合条件的服务端推送 |

协商 `session.output_voice` 能力后，客户端可以直接调用 SDK 的
`GatewayClient.updateOutputVoice(voice)`。对应线协议为：

```jsonc
{
  "type": "session.output_voice.update",
  "event_id": "evt_client_voice_1",
  "voice": "longanlufeng"
}
```

```jsonc
{
  "type": "session.output_voice.updated",
  "event_id": "evt_gateway_voice_1",
  "request_event_id": "evt_client_voice_1",
  "voice": "longanlufeng",
  "changed": true,
  "reconnecting": true
}
```

`changed` 表示偏好是否变化，`reconnecting` 表示 Gateway 是否正在用新音色重建上游
Realtime Session。Provider 不支持会话音色时返回关联错误
`output_voice_unsupported`，Client 不需要识别具体 Provider。

`permission.respond.decision` 支持 `task`、`always` 和 `reject`，分别表示
允许当前 Task 及其后续操作直到完成、失败或取消；当前前端会话内跨 Task
始终允许；以及拒绝当前操作。授权策略由 Gateway 管理，BackendPort 仍接收逐次
操作的决定。授权不跨 Gateway 重启保存。线协议 7.0 将 `once` 替换为 `task`，
客户端须更新 schema，不能把“本次允许”悄悄解释成任务授权。

`task.create` 使用与 A2A 语义对齐的 `message.parts`，而不是另设只能传纯文本的 objective 字段。这样显式集成可以提交文本、文件或结构化 Part，同时不引入 A2A Message 原生对象。

这是 Client 的运行时控制面。等价的内部 REST/SSE 路由作为迁移别名保留，直到所有第一方 Client 都改用 WebSocket 命令和回放路径。REST 仍适合启动发现、健康检查、静态配置，以及不属于活动 Client Session 的 Host 管理操作。

`task.create` 是显式集成命令，不是常规语音聊天路径。对话请求仍由前台 Agent 通过工具创建 Task，以保留它的路由判断和自然承接行为。

### 5.5 Gateway 状态与 Presentation

Gateway 发布规范化状态，Client 不需要反向推导内部状态机：

- `gateway.*`、`voice.*`：连接和前台状态；
- `response.*`、转写和音频事件：对话输出；
- `task.*`：Task 生命周期、活动、Artifact 与通知状态；
- `task.permission.*`、`task.input.*`：权限与补充输入状态；
- `playback.clear` 等明确的展示控制。

每个公开 Task 只有一个 Gateway `task_id`。ACP Session ID、A2A 远程 Task ID 和自定义 Adapter ID 留在 `BackendPort` Adapter 内部。

Task 快照和更新使用 Gateway 自己的包装，但嵌套形状刻意与 A2A 语义对齐：

```jsonc
{
  "type": "task.updated",
  "event_id": "evt_gateway_88",
  "sequence": 41,
  "task_id": "task_42",
  "status": {
    "state": "working",
    "message": {
      "role": "agent",
      "parts": [{ "text": "正在检查磁盘空间。" }]
    }
  },
  "artifacts": []
}
```

状态词汇和事件生命周期由 Gateway 定义。嵌套的 `status.state`、`status.message.parts` 和 `artifacts[].parts` 便于复用 Adapter 与 UI，但不属于 A2A 原生对象。

Task 进展可以推送给 Client，但不一定进入 Realtime 模型。Gateway Event Policy 只选择有意义的进展、权限、补充输入、完成和失败事件进行模型投递。`input_required` 仍是活动 Task 状态；回答会恢复同一 Task，而不是新建一项工作。

`task.progress` 只在后台活动实际变化时合并发送，不承担连接保活。WebSocket Client
使用 `session.ping` / `session.pong`（旧客户端使用 WebSocket 控制帧）；兼容性的
Task SSE 路由只写传输层注释心跳。这些注释不会进入 Task 回放或 Session Journal。

### 5.6 回执与决策

| 事件 | 方向 | 语义 |
|---|---|---|
| `playback.started` | C→G | 实际播放已经开始 |
| `playback.ended` | C→G | 实际播放已经完成 |
| `playback.cancelled` | C→G | 播放被丢弃或打断 |
| `client.action.result` | C→G | Client Action 完成或失败 |
| `permission.respond` | C→G | 用户授权决策 |
| `task.input.respond` | C→G | 回答后台当前追问 |

`response.done` 只表示生成完成，不表示用户已经听到。确实需要可听送达确认的工作流使用播放回执。

### 5.7 本地静音与外部采集占用

本地静音只在 Client 停止麦克风输入，不断开连接、不取消 Task、不抑制输出，不需要 Gateway 事件。

外部采集占用更强，仍然是共享控制工作流：

```text
input.capture.suspend / input.capture.suspended
input.capture.resume  / input.capture.resumed
```

暂停必须有 TTL。可信 Host Contract 可以请求暂停，而不建立第二个 Gateway Client 连接。

## 6. 内部语义路由

公开线协议保留类型，提交后的语义输入进入同一个进程内 Router：

```text
已提交用户输入 ─┐
Client Event ────┤
Task Event ──────┼→ GatewayEventRouter
Gateway Trigger ─┘        ├─ 确定性 Handler
                          ├─ 状态/回放投影
                          ├─ Client Presentation
                          └─ 可选 AgentDelivery
```

它是进程内 Registry 与 Dispatcher，不是消息中间件。原始音频帧和输出增量绕过它。

可选的 Provider 无关 `AgentDelivery` 描述 Realtime 前台 Agent 如何感知事件：

```js
{
  id: 'delivery_123',
  causeEventId: 'evt_client_17',
  origin: 'client',
  text: '用户触摸了桌面上的水杯。',
  mode: 'context',
  correlation: { eventName: 'user.object.touched' },
  presentation: { instructions: '', allowTools: false, contextTiming: 'response' }
}
```

`presentation` 是可选的 Provider 无关回复策略，可以约束回复表达方式、前台 Agent
能否调用自身工具，以及上下文是否必须先于排队中的回复生效；它绝不是某个 Realtime
Provider 的 response 对象。

路由模式：

- `handle`：Gateway 确定性处理，不产生 `AgentDelivery`；
- `context`：更新模型上下文，不创建回复；
- `respond`：更新上下文，在安全边界安排回复；
- `interrupt`：打断当前回复、更新上下文并请求回复。

`AgentDeliveryRuntime` 管理用户说话阻塞、回复串行化、休眠暂存、重试和播放确认。Realtime Provider Adapter 再转换成自己的线协议。不能把 Client 原始 JSON 直接粘贴进模型 Prompt。

Gateway 自身产生且需要前台 Agent 感知的事件也使用同一边界。例如 Realtime
内容被拒绝后，Gateway 先排除失败轮次并恢复连接，再投递
`realtime.content_rejected`。模型只会收到脱敏的“上一轮内容无法回复，请换个话题”，
不会收到供应商错误对象、错误码或被拒绝的原始内容。

提醒到期同样注册为 Gateway 自有系统事件 `reminder.due`。其有界载荷只包含提醒内容、
计划时间、重复规则与时区；Task 和循环标识保留在 `AgentDelivery.correlation`，不会
复制进模型可见文本。

## 7. Presence 与休眠

主动休眠：模型调用客户端声明的 `enter_sleep` → 网关转发调用 →
客户端静音并隐藏 → 返回工具结果。成功不触发续答，失败仍可说明原因。

自动休眠：客户端本地计时到期 → 自己静音并隐藏 →
通过 `client.event.publish` 发送上下文说明。不要求模型再调用工具，
网关也不按事件名称再次执行隐藏。

两种情况都由客户端通过独立的 `client.presence.update` 同步实际状态：

```json
{
  "type": "client.presence.update",
  "event_id": "evt_presence_1",
  "state": "sleeping"
}
```

需协商 `client.presence`；`state` 为 `sleeping` 或 `active`。
它只更新网关的输入/播报门控，不代表执行客户端隐藏，也不代替模型上下文信息。
客户端只在实际状态改变后上报，并在重连后同步当前状态。

桌面客户端还通过 `client.event.publish` 的 `context` 模式同步休眠/唤醒状态文本。
文本保留实际原因：空闲超时自动休眠、执行休眠请求、唤醒恢复；共用同一事件通道，
不新增工具或协议类型，网关不根据原因执行操作。
这是同一条最新状态快照，重复状态不重复投递，Realtime 重连后重新同步；不触发播报。
因此模型既能知道休眠已经执行，也能知道用户已唤醒客户端，不会只看到旧的休眠回执。

休眠不取消后台工作、不丢弃待播报结果、不主动断开 Realtime。
唤醒由客户端实现，恢复 `active` 后投递暂存通知。已有宿主发起的 PresenceController
动作仍保留，但不再承担客户端自动休眠的信息事件处理。

## 8. 回放、错误与限制

`session.replay` 按 `sequence` 分页回放服务端推送，默认 50、最大 200。过期 Session 或 sequence 返回明确错误。在可靠回放完成前，不能删除等价的 REST/SSE 恢复接口。

基础错误码：

```text
client_occupied
protocol_version_unsupported
capability_unsupported
capability_not_negotiated
bad_event
unknown_type
client_event_unsupported
client_event_invalid
client_action_unsupported
session_expired
sequence_expired
task_not_found
task_not_cancellable
permission_not_found
payload_too_large
rate_limited
internal
```

错误不能暴露凭据、后台原生对象、堆栈或敏感本机路径。

事件定义负责 payload、频率、保存和合并限制。最新状态必须覆盖原有 key，不能无限追加。高频传感器应发布语义变化，不能直接发布原始采样或鼠标移动流。

## 9. 信任与扩展

- Gateway 根据连接身份填写可信 Client 来源，调用方不能自称任意可信 source。
- `client.event.publish` 不能发布顶层 `task.*`、`permission.*`、`gateway.*` 或 `response.*` 事件。
- 模型投影将 Client Event 标记为观察或环境事件，而不是系统指令或用户命令。
- 扩展在 Gateway 组合时注册名称、Schema、Projector 和 Policy。
- 内置 Action 需要 capability；扩展 Action 需要已安装且可信的 Client/Host 扩展。
- 一个活动 Client 可以聚合多个本地传感器和环境来源，不需要增加 Gateway Socket。

基础 API 使用现有 WebSocket。7.0 不提供绕过活动 Client 的独立 HTTP、`context_source` 或 Integration 连接。未来部署若需要机器直接向 Gateway 投递事件，必须重新做出明确协议决策，不能悄悄演变成第二种 Client 角色。

## 10. 与外部标准的关系

Gateway 协议定义自己的类型。下表是刻意且非规范性的语义对齐：帮助实现者识别熟悉概念，但不引入外部标准的原生协议对象。

| Gateway 概念或形状 | 语义对齐 | 边界 |
|---|---|---|
| `input_audio_buffer.*`、`conversation.item.create`、回复与音频事件名 | [OpenAI Realtime](https://platform.openai.com/docs/api-reference/realtime-client-events) 的媒体、对话、回复与取消词汇 | Gateway Schema、握手、扩展和生命周期才是权威契约；不宣称完整线兼容 |
| `task_id`、`status.state`、`status.message.parts`、`artifacts[].parts` | [A2A](https://a2a-protocol.org/latest/specification/) 的 Task、状态、Message 与 Artifact 语义 | A2A 传输、JSON-RPC 对象、远程 Task ID 和 Agent Card 留在 A2A Backend Adapter 内部 |
| 规范化权限和后台活动 | ACP 的权限、Session Update、Tool Call 与计划语义 | ACP 请求/更新对象与 Session ID 留在 ACP Backend Adapter 内部 |
| 可选的只读活动投影 | AG-UI 活动语义 | AG-UI 不作为 GCP 基线传输或命令面 |
| 前台工具和外部服务 | MCP / OpenAPI 工具语义 | 不替代 Client Event、Client Action 或 Gateway 运行时命令面 |

## 11. 从 5.x 迁移

1. 固化本文档，为当前客户端增加 characterization tests。
2. 增加 6.0 信封、握手、capabilities 和 Parser，同时继续接受 5.x 别名。
3. 增加 `GatewayEventRouter`、Client Event Registry、`client.event.publish/result` 和 WebSocket 运行时命令/查询面。
4. 增加 Provider 无关 Agent Delivery，复用当前 Task 播报可靠性。
5. 增加 `ClientActionPort` 和 `client.action.request/result`，首先迁移 `enter_sleep`。
6. WebUI、TUI、Desktop 依次迁移到共享参考 Client SDK。
7. 增加回放与完整 conformance coverage；把 Task、权限和对话运行时调用从内部 REST/SSE 别名迁走。
8. 停止写出 5.x 与 REST/SSE 运行时别名，并在明确的废弃版本之后删除。

健康检查、静态资源、安装和设置仍是 Host/运维 API，不强制迁移到业务 WebSocket。

## 12. Conformance 要求

当前线协议的稳定行为由以下测试范围锁定：

- 按用户单 Client 占用、显式接管、租约代次 fencing、释放与心跳超时；
- 版本与 capability 协商；
- `event_id`、`request_event_id` 和回放 `sequence`；
- 用户输入与 Client Event 的权限差异；
- 已注册、未知、不合法、重复、限流和合并 Client Event；
- 四种路由模式且不重复投递模型；
- 所有 Realtime Provider 的 Provider 无关 context-only 与 response 投递；
- Client Action capability、结果、失败、超时与重连；
- 主动休眠与自动休眠进入同一个幂等状态机；
- Client 自动休眠时的模型失败兜底；
- 本地静音与外部采集暂停；
- Task、权限投影不泄漏后台协议；
- WebUI、TUI 和 Desktop 通过同一套契约测试。

## 13. 明确不做

- 同一用户下的并发控制 Client、Observer 与任意踢出语义。
- 在编排运行时中依赖 Electron、React、CoreAudio 或具体 Client。
- 将 ACP 规定为唯一后台协议。
- 允许任意 Client 数据成为模型指令。
- 强制每个 Client Event 或 Task 进展进入模型或产生播报。
- 在编排运行时中实现唤醒词、窗口布局或本地静音。
- 在可靠回放完成前删除恢复接口。
