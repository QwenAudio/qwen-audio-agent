# Gateway Client Protocol

> 状态：**Stable 6.0**<br>
> 线协议版本：**6.0.0**<br>
> Roadmap：[GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)<br>
> 当前实现事实源：`shared/gateway-client-protocol.mjs`、`server/src/client/client-event-router.mjs`、`server/src/client/client-command-runtime.mjs`、`shared/realtime-events.mjs`、`shared/protocol/gateway-events.mjs` 与 `server/src/core/gateway-protocol.mjs`

本文档定义 qwen-audio-agent Gateway 与唯一活动 Client Environment 之间已经落地的北向协议。当前第一方客户端使用 6.0 线协议；健康契约 5.x 的旧入口仅作为临时兼容别名保留。

## 1. 产品边界

```text
Client Environment
        ↕ Gateway Client Protocol
Gateway Core + Realtime Frontend Agent
        ↕ BackendPort
Backend Agent
```

三个角色相互独立：

- **Gateway Core** 管理 Realtime 前台 Agent、对话、工具、Task 生命周期、权限、路由、Presentation 与恢复。
- **Backend Agent** 是用户提供的执行环境。Gateway 只通过 `BackendPort` 访问，由 ACP、A2A 或自定义 Adapter 实现。
- **Client Environment** 负责 I/O、显示、播放、本地 UX、传感器、客户端状态、用户行为和外部环境动作。

TUI、WebUI 和桌面悬浮球是第一方参考客户端；OpenCode、Qwen Code、Pi、OpenClaw、远程 A2A Agent 等是参考后台。两者都不限制框架可接入的实现。

## 2. 架构不变量

1. 同一个 Gateway 实例同一时刻只接受一个活动 Client 连接。
2. Client 的业务流量使用一条 WebSocket，不额外建立 context 或 observer 连接。
3. 原始音频走媒体快速路径，只有已经提交的语义输入进入语义路由。
4. Client **Event** 描述发生了什么；Client **Action** 要求环境执行操作并返回结果。
5. Realtime Tool Call 是模型接口；适用的 Tool Call 由 `ClientActionPort` 映射为 Client Action。
6. Gateway 决定事件是确定性处理、只进入模型上下文、稍后回复还是立即回复。
7. Client Event 不能伪造 Gateway、Task、权限或后台生命周期事件。
8. Realtime Provider 与后台协议的原生协议对象不能跨越本边界。所有公开类型由 Gateway 定义；语义一致时，可以刻意对齐外部标准中熟悉的字段命名和形状。
9. 本地静音、窗口布局、唤醒手段和渲染属于 Client；只有影响共享状态的部分进入协议。
10. 在全部第一方客户端完成迁移并具备 conformance coverage 前，现有行为通过兼容别名继续可用。

## 3. 连接与能力协商

Client 连接 `ws://<gateway>/api/realtime`，第一条消息必须是 `session.hello`。

```jsonc
{
  "type": "session.hello",
  "event_id": "evt_client_1",
  "protocol": { "min": "6.0.0", "max": "6.0.0" },
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
  "protocol_version": "6.0.0",
  "session_id": "session_01",
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
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ]
}
```

规则：

- 已有活动 Client 时，新连接收到 `client_occupied` 后关闭。
- WebSocket 关闭或心跳超时后释放连接所有权。
- 6.0 不提供接管、踢出、并发观察或多 Client 仲裁。
- Client 必须依据协商后的 capabilities 判断能力，不能只比较产品版本。
- 协议版本、Client 身份和能力不能在当前连接中改变；需要改变时重连。
- 6.0 不定义 `context_source`、`integration` 或 Observer 连接角色。车辆总线、CRM、传感器等上下文来源通过客户端侧 Adapter 接入当前活动 Client Environment，再由该 Client 校验并转发已注册的语义事件。

### 3.1 GCP1 兼容落地

GCP1 在不分叉 Gateway 业务逻辑的前提下实现信封与握手。6.0 Client 以
`session.hello` 开始；Gateway 返回 `session.ready`，为后续下行事件补充
`event_id`，并把 6.0 输入别名归一化到现有内部事件模型。5.x Client 仍可使用
`connect`，收到的旧事件形状保持不变。握手只协商已有运行时实现的能力。GCP2 的
Client Event 与运行时命令 capability、GCP3 Agent Delivery、GCP4 Client Action
以及 GCP5 参考 Client 与有限回放均已实现。

### 3.2 GCP2 运行时落地

GCP2 在协商后的同一条 WebSocket 上实现 `client.event.publish`，以及第 5.4 节的
Task、权限和对话历史命令。即时结果与错误通过 `request_event_id` 关联。现有 REST
路由调用同一个 Runtime Command Service，并暂时作为兼容别名保留。

Client Event Definition 在 Gateway 组合阶段注册。Registry 统一定义 payload
Schema、大小、频率、保存、合并、最大路由等级与可选确定性 Handler。Gateway 根据
已认证连接填写 owner、Session、Client 类型与 Client 实例；这些可信字段不能由
Event data 提供。首个内置定义是 `desktop.presence.sleep_requested`。GCP2 负责接收、
校验、保存和确定性处理，不会把它伪装成用户输入；GCP3 已经把它投影到统一的 Agent
Delivery 边界。

确定性 Handler 可以使用 Gateway 宿主提供的窄效果，例如从部署方拥有的
Assistant Profile 白名单中为当前 Realtime Session 选择一项。Client 仍然只能发送
Schema 校验过的标识：Event data 不会直接变成指令，效果也不接受任意 Prompt 文本。

### 3.3 GCP3 Delivery 落地

GCP3 实现第 6 节定义的 Provider 无关值与四种路由模式。Task 最终结果、有意义的低频
进展、权限请求和已注册 Client Event 投影统一进入 `RealtimeAgentDeliveryRuntime`。
Realtime Provider 只编码最终的上下文项与可选回复；Client 或后台协议原始对象不会
进入模型。现有 Task 播报的批处理、安全窗口重试、通知认领和播放确认继续作为这条共享
投影外围的可靠生命周期。

### 3.4 GCP4 Client Action 落地

GCP4 实现有关联关系的 `client.action.request/result` 与协议无关的
`ClientActionPort`。只有当前 Client 声明对应 capability，Realtime 才能看到由
Action 派生的工具。`enter_sleep`、桌面空闲事件与旧 Gateway 超时入口统一进入
幂等 `PresenceController`；支持 Action 的 Client 只有在环境切换成功回执后才会被
标记为 sleeping。第一方桌面 Client 已通过 `session.hello` 协商并回传 Action
Result；5.x `connect` 只保留为废弃兼容别名。

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
  "data": { "object_id": "cup" }
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

所有控制消息使用 UTF-8 JSON 文本帧。6.0 在 JSON 中以 base64 承载 PCM 音频；未来可以通过能力协商增加二进制媒体帧，而不改变语义事件路由。

## 5. 协议面

### 5.1 用户输入与媒体

语义相同时采用 OpenAI Realtime 词汇：

| 事件 | 方向 | 语义 |
|---|---|---|
| `input_audio_buffer.append` | C→G | 追加输入音频 |
| `conversation.item.create` | C→G | 提交文本、图片、文件或混合用户输入 |
| `response.cancel` | C→G | 打断当前回复 |
| `response.created` | G→C | 回复开始生成 |
| `response.output_audio.delta` / `.done` | G→C | 音频输出 |
| `response.output_audio_transcript.delta` / `.done` | G→C | 助手转写 |
| `response.done` | G→C | 回复最终状态；取消使用 `response.status = "cancelled"` |

Gateway 扩展包括 `turn.started`、`transcript.discard`、`playback.clear` 和播放回执。`input_file` 是 Gateway content part 扩展，不属于 OpenAI Realtime 标准字段。

用户输入代表明确的用户意图，会开启或替代用户轮次。Client 语义事件不能伪装成用户输入。

### 5.2 Client 语义事件

公开、可扩展的 Client-to-Gateway API：

```text
client.event.publish
client.event.publish.result
```

```jsonc
{
  "type": "client.event.publish",
  "event_id": "evt_client_17",
  "occurred_at": 1787880000000,
  "name": "user.object.touched",
  "data": {
    "object_id": "cup",
    "object_name": "水杯"
  }
}
```

```jsonc
{
  "type": "client.event.publish.result",
  "event_id": "evt_gateway_31",
  "request_event_id": "evt_client_17",
  "accepted": true,
  "name": "user.object.touched"
}
```

`name` 必须由 Gateway 协议或已安装扩展注册。注册定义：

- payload Schema 与大小限制；
- 一次性或最新值保存策略；
- 必要时的去重或合并键；
- 默认路由策略；
- 可选的确定性 Handler；
- 可选的 Provider 无关模型投影；
- 回放和客户端展示行为。

建议命名空间包括 `desktop.*`、`environment.*`、`vehicle.*`、`hardware.*` 和扩展自己的前缀。未知名称返回 `client_event_unsupported`，不合法数据返回 `client_event_invalid`。

调用方不能决定最终模型行为。事件定义可以选择接受 `delivery_hint`，但 Gateway 只能降级紧急程度，不能升级。

### 5.3 Client Action

Gateway-to-Client 操作使用请求/结果事件：

```text
client.action.request
client.action.result
```

```jsonc
{
  "type": "client.action.request",
  "event_id": "evt_gateway_51",
  "name": "desktop.presence.enter_sleep",
  "arguments": {}
}
```

```jsonc
{
  "type": "client.action.result",
  "event_id": "evt_client_52",
  "request_event_id": "evt_gateway_51",
  "status": "completed",
  "output": null
}
```

`status` 为 `completed`、`failed` 或 `unsupported`。失败包含有界的 `{code, message}`。只有活动 Client 协商了相应 capability，Gateway 才向 Realtime 暴露由该 Action 派生的工具。

首个实现的 Action 是 `desktop.presence.enter_sleep`。它的工具调用、自动 Client
Event 兜底、超时和重复请求共用一个 Presence 状态机。旧 `client.state` sleeping
消息仍作为当前 Client 的迁移兼容入口，但不再承担实际执行边界。

Client Action 不替代 MCP、OpenAPI、ACP 或 A2A。它只用于当前 Client Environment 自己拥有的能力；其他外部系统继续使用适合的工具或 Backend Adapter。

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

`permission.respond.decision` 支持 `once`、`always` 和 `reject`，分别表示
仅允许当前操作、当前前端会话内始终允许，以及仅拒绝当前操作。

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

## 7. Presence 与休眠

两种休眠最终进入同一个 PresenceController 和 Client Action 链路，但只有用户主动休眠需要模型工具调用。

### 用户主动休眠

```text
用户输入 → Realtime → 可选承接语 → enter_sleep
         → PresenceController → ClientActionPort
         → desktop.presence.enter_sleep → Client Action Result
         → Gateway 进入 sleeping
```

模型可以先说话，也可以直接调用工具。协议不强制告别话术，也不强制等待播放结束。工具失败只作为工具结果返回，不主动触发播报。

### Client 自动休眠

```text
client.event.publish(desktop.presence.sleep_requested)
         → GatewayEventRouter → AgentDelivery(context)
         → Realtime 获知客户端即将休眠（不回复、不调用工具）
         → Gateway → PresenceController → ClientActionPort
         → 客户端静音并隐藏 → Gateway 进入 sleeping
```

Client 在本地空闲时间到期后发布事件，可携带空闲时长、原因等有界状态信息。Gateway 把它作为上下文投递给 Realtime 后，确定性地执行休眠；自动休眠不依赖模型生成，也不要求模型再次调用 `enter_sleep`。

状态机：

```text
active → sleep_requested → sleeping
```

只有第一次转换发出 Client Action。重复请求复用正在进行的转换或返回已休眠状态。只有 Client Action 成功后，Gateway 才标记为 `sleeping`。休眠不会取消后台 Task，也不会丢弃待播报结果。

唤醒手段属于 Client。休眠期间 Gateway 保持 Realtime Provider 连接，只停止向其发送
客户端音频；唤醒事件恢复 Presence、麦克风输入并投递暂存通知。

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

基础 API 使用现有 WebSocket。6.0 不提供绕过活动 Client 的独立 HTTP、`context_source` 或 Integration 连接。未来部署若需要机器直接向 Gateway 投递事件，必须重新做出明确协议决策，不能悄悄演变成第二种 Client 角色。

## 10. 与外部标准的关系

Gateway 协议定义自己的类型。下表是刻意且非规范性的语义对齐：帮助实现者识别熟悉概念，但不引入外部标准的原生协议对象。

| Gateway 概念或形状 | 语义对齐 | 边界 |
|---|---|---|
| `input_audio_buffer.*`、`conversation.item.create`、回复与音频事件名 | [OpenAI Realtime](https://platform.openai.com/docs/api-reference/realtime-client-events) 的媒体、对话、回复与取消词汇 | Gateway Schema、握手、扩展和生命周期才是权威契约；不宣称完整线兼容 |
| `task_id`、`status.state`、`status.message.parts`、`artifacts[].parts` | [A2A](https://a2a-protocol.org/latest/specification/) 的 Task、状态、Message 与 Artifact 语义 | A2A 传输、JSON-RPC 对象、远程 Task ID 和 Agent Card 留在 A2A Backend Adapter 内部 |
| 规范化权限和后台活动 | ACP 的权限、Session Update、Tool Call 与计划语义 | ACP 请求/更新对象与 Session ID 留在 ACP Backend Adapter 内部 |
| 可选的只读活动投影 | AG-UI 活动语义 | AG-UI 不作为 6.0 基线传输或命令面 |
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

6.0 的稳定行为由以下测试范围锁定：

- 全局单 Client 占用、释放和心跳超时；
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

- 多用户、多 Client 并发、Observer、接管或踢出。
- 在 Gateway Core 中依赖 Electron、React、CoreAudio 或具体 Client。
- 将 ACP 规定为唯一后台协议。
- 允许任意 Client 数据成为模型指令。
- 强制每个 Client Event 或 Task 进展进入模型或产生播报。
- 在 Gateway Core 实现唤醒词、窗口布局或本地静音。
- 在可靠回放完成前删除恢复接口。
