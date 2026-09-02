# Gateway 契约

本文件是外部客户端（桌面版、CLI、WebUI，或集成 qwen-audio-agent 的平台方）
可以依赖的**唯一契约索引**。未在此列出的一切（内部模块路径、配置目录内除下文
点名之外的文件布局、数据库与状态文件格式）都不属于契约，可能在任意版本变更。

本文件中的每一条承诺都有测试锁定；各节表格中注明了对应测试。

## 协议版本与能力位

`GET /api/health` 返回 `protocolVersion` 与 `capabilities`。客户端应按能力位
分支，而不是比较产品版本号——旧版 Gateway 会降级而不是报错。

版本号遵循 SemVer：新增能力升 minor；下文点名的任一端点或事件发生破坏性
变更升 major。

稳定的 6.0 北向边界记录在
[Gateway Client Protocol](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/gateway-protocol.zh.md) 与
[已完成的 Roadmap](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/roadmap/gateway-client-protocol.zh.md) 中，并由已关闭的
[GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)
记录。GCP1–GCP5 已完成：6.0 握手、Client Event Ingress、运行时命令面、Agent
Delivery、Client Action、参考 Client SDK 与有限回放均落在同一条 WebSocket 上。
已实现行为仍以本契约索引为准。

当前健康契约版本为 `5.6.0`。新增的 `5.6` 能力为可替换客户端提供
Provider 无关的前台记忆控制面。`5.5` 能力提供共享参考 Client SDK、有限 Task
事件回放与断线状态恢复。第一方 WebUI、Desktop 和 TUI 已通过同一套一致性测试，
Task 控制、权限决策和对话历史不再依赖内部 REST 路由。`5.4` 能力提供有关联关系的 Client Action 与共享
Presence 状态机；`5.3` 增加 Provider 无关 Agent Delivery；`5.2` 在协商后的 6.0
WebSocket 上提供已注册
Client Event Ingress 与 Task、权限、对话历史命令，同时保留 REST 兼容别名。`5.1`
能力提供可选 GCP 6.0
`session.hello` / `session.ready` 握手，同时保留 5.x `connect` 路径与业务事件别名。
`5.0` 删除由后台控制的 Task `presentation` 包装：后台只返回
事实性 `content` 与可选的类型化 `artifacts`，前台 Chatbot 决定如何播报，各个对话
客户端决定如何呈现。同一版本同时将现有 `WS /api/realtime` 事件模型正式发布为
可替换的对话客户端边界。`4.0` 将原来的 `workId` / `jobId` 双重身份收敛为 Task 的唯一短
`id`（模型工具结果中为 `task_id`），并增加 `task.updated` 增量快照。该字段变更会影响
读取 Task 事件的客户端，因此升 major。`3.1` 在最终助手转写事件中增加有界 Citation。`3.0` 为原生
Task 事件提供与 A2A 对齐的 `submitted`、
`working`、`auth_required` 状态，以及类型明确的产物与授权对象。它替换了
`2.x` 的 `active` 状态与不透明结果元数据，因此事件消费者必须检查下方能力位。
`2.1` 新增了可选的 AG-UI Task 事件投射，且未改变默认事件流。`2.x` 接替
`feat/embedded-gateway-host-contract` 分支的 `1.x`
版本线（止于 `1.7.0`）：升 major 记录的事实是——那条线宣告过的部分能力位
（如 `gateway.embedded-lifecycle`、`desktop.settings-window`）不在本契约中。
从该分支迁移的宿主应重新核对下方能力位表，而不是假设旧清单仍然成立。

| 能力位 | 含义 | 锁定测试 |
| --- | --- | --- |
| `web.same-origin-ui` | Gateway 在自己的 origin 上静态托管 Web UI，webview 指向 Gateway 地址即可，无需额外配置 | `test/consumer-install.test.mjs` |
| `web.skin-assets` | 导入的悬浮球皮肤在 Gateway origin 的 `/skins/<id>/` 下提供，悬浮球页面的同源素材请求无需宿主另起静态服务 | `test/consumer-install.test.mjs` |
| `gateway.instance-lease` | 配置目录中的租约标识运行中的实例；`/api/health` 回显 `gatewayInstanceId`，同端口的陌生进程不会被误认为本 Gateway | `test/consumer-install.test.mjs` |
| `gateway.setup-gate` | 未配置的启动以 `QWAUDIO_GATEWAY_SETUP_REQUIRED` 拒绝并附带 `missing` 清单，而不是运行一个语音不可用的实例 | `test/gateway-setup.test.mjs` |
| `gateway.settings-store` | 配置持久化由本包自持：`createSettingsStore({ configDir })`——宿主不认识任何配置项、不持有任何配置文件 | `desktop/test/settings-store.test.mjs` |
| `host.electron-entry` | `qwen-audio-agent/electron`：Electron 主进程可直接 `require` 的 CommonJS 入口，一次 `load()` 拿到全部契约 | `test/consumer-install.test.mjs` |
| `host.gateway-process` | `GatewayProcess` 随包发布：fork、端口回退、就绪握手、重启、计划退出与崩溃分离——桌面版跑的是同一份实现 | `desktop/test/gateway-process.test.mjs` |
| `input.suspend-protocol` | `POST /api/input/suspend\|resume`、`GET /api/input`；Gateway 通过 `input.suspend` / `input.resume` 把抢占传达给客户端 | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-clears-playback` | 抢占同时清除播报，宿主录音不会录进 Gateway 自己的语音 | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-ttl` | 持有者不主动释放时抢占自行过期 | `server/test/input-arbitration.test.mjs` |
| `input.suspend-ack` | 客户端以 `input.suspend.ack` 确认抢占生效（仅用于状态展示——不要等待它） | `server/test/input-suspend-protocol.test.mjs` |
| `tasks.ag-ui-event-stream` | `GET /api/tasks/:id/events?format=ag-ui` 将现有 Task 事件流投射为 AG-UI `ACTIVITY_SNAPSHOT`；不传 `format` 时仍为原生事件流 | `server/test/agui-event-projector.test.mjs` |
| `tasks.structured-results-authorization` | 原生 Task 事件使用与 A2A 对齐的工作状态，并暴露事实性 `result`、类型化 `artifacts` 与 `authorization`，不规定播报或 UI | `test/gateway-event-schema.test.mjs`、`server/test/task-state.test.mjs` |
| `tasks.unified-id-updates` | Task 只公开一个短 `id`；`task.updated` 携带 Adapter 归一化后的增量消息与产物 | `test/gateway-event-schema.test.mjs`、`server/test/task-manager.test.mjs` |
| `messages.citations` | 最终助手 `transcript.final` 可以携带同一轮前台检索产生的规范化 Citation | `test/gateway-event-schema.test.mjs`、`server/test/realtime-presentation-runtime.test.mjs` |
| `frontend.memory-control` | `GET/PATCH /api/memory` 供可替换客户端列出并精确编辑 Realtime 共用的 Provider 记忆文档，不暴露具体存储实现 | `server/test/gateway-application.test.mjs` |
| `realtime.conversation-client-v1` | `WS /api/realtime`、公开事件常量与消息 Schema 共同构成可替换的文本/音频/多模态对话客户端边界 | `test/gateway-event-schema.test.mjs`、`test/custom-conversation-client.test.mjs` |
| `realtime.gateway-client-protocol-v6-handshake` | 同一 WebSocket 可选择以 6.0 `session.hello` 接入，返回有关联关系的 `session.ready`，协商已实现能力，并把 6.0 输入别名归一化到现有业务路径 | `test/gateway-client-protocol.test.mjs`、`server/test/gateway-client-handshake.test.mjs` |
| `realtime.gateway-client-protocol-v6-runtime-commands` | 协商后的 6.0 Client 可以通过同一 WebSocket 发布已注册的语义 Client Event，并使用有关联结果的 Task、权限、对话历史和会话输出音色命令；现有 REST 路由调用同一命令服务作为兼容别名 | `test/gateway-client-protocol.test.mjs`、`server/test/client-event-router.test.mjs`、`server/test/client-command-runtime.test.mjs`、`server/test/gateway-client-handshake.test.mjs` |
| `realtime.gateway-client-protocol-v6-agent-delivery` | Client Event、Task 结果与低频进展、权限请求统一跨越 Provider 无关 `AgentDelivery` 边界，并支持 `handle`、`context`、`respond`、`interrupt` 四种模式 | `server/test/agent-delivery.test.mjs`、`server/test/client-event-router.test.mjs`、`server/test/realtime-provider.test.mjs`、`server/test/announcement-manager.test.mjs` |
| `realtime.gateway-client-protocol-v6-client-actions` | 有关联关系的 `client.action.request/result` 执行 Client 自有环境操作；`enter_sleep` 按 capability 暴露，只有 Client 成功后才提交 sleeping | `test/gateway-client-protocol.test.mjs`、`server/test/client-action-port.test.mjs`、`server/test/gateway-client-handshake.test.mjs`、`desktop/test/enter-sleep-flow.test.mjs` |
| `realtime.gateway-client-protocol-v6-reference-client-replay` | 共享参考 Client SDK 统一处理握手、命令关联、`updateOutputVoice()`、Client Action、重连与状态恢复；Task 推送以 `sequence` 有限回放，WebUI、Desktop、TUI 共用一致性测试 | `test/gateway-client-sdk.test.mjs`、`test/gateway-client-conformance.test.mjs`、`server/test/gateway-client-protocol-session.test.mjs`、`server/test/gateway-client-replay-buffer.test.mjs` |
| `desktop.orb-shell` | 悬浮球形态的主进程契约随包发布：`bindOrbShell` 应答随包 preload 发出的全部通道 | `desktop/test/orb-shell.test.mjs` |
| `desktop.orb-window-factory` | `createOrbWindow` 持有悬浮球窗口配方；其 `destroy()` 是宿主的同步销毁路径（渲染进程退出才能确定性释放麦克风） | `desktop/test/orb-window.test.mjs` |
| `desktop.orb-placement` | `createOrbPlacement` 覆盖默认锚点、显示器夹取与拖放持久化 | `desktop/test/orb-placement.test.mjs` |
| `desktop.orb-position-store` | 悬浮球位置由本包记忆（settings store 的 ui-state） | `desktop/test/settings-store.test.mjs` |
| `desktop.skin-store` | 皮肤的导入、列表、删除与生效决策是发布的库接口 | `desktop/test/skin-store.test.mjs` |

能力位清单本体是 `server/src/core/gateway-protocol.mjs` 的
`GATEWAY_CAPABILITIES`；`test/gateway-contract.test.mjs` 会在能力位与本文档
不一致时失败。

## 包入口（package exports）

只有下列子路径属于契约；按内部路径引用不受支持，随时会断。

| 入口 | 导出 |
| --- | --- |
| `qwen-audio-agent/electron` | **CJS**：`load()`（一个命名空间拿到全部契约）、`PRELOAD_PATH` |
| `qwen-audio-agent/gateway-protocol` | `GATEWAY_PROTOCOL_VERSION`、`GATEWAY_CAPABILITIES` |
| `qwen-audio-agent/gateway-client-protocol` | GCP 6.0 信封、握手与运行时命令 Schema、解析器、能力常量和参考 Client Helper |
| `qwen-audio-agent/gateway-client-sdk` | `GatewayClient`：WebSocket 生命周期、6.0 握手、请求关联、Client Action、有限回放和重连恢复 |
| `qwen-audio-agent/gateway-client-profiles` | WebUI、Desktop、TUI 的参考 capability profile |
| `qwen-audio-agent/client-events` | 供 Gateway 扩展使用的 Client Event Definition Registry、内置定义、路由 Policy 与 `GatewayEventRouter` |
| `qwen-audio-agent/client-actions` | `ClientActionPort`、内置 Action 名称、capability 映射、请求/结果关联、deadline 与进行中请求去重 |
| `qwen-audio-agent/agent-delivery` | Provider 无关的 `AgentDelivery` 值与路由模式 |
| `qwen-audio-agent/gateway-setup` | `gatewaySetupStatus`、`assertGatewaySetup` |
| `qwen-audio-agent/gateway-process` | `GatewayProcess`、`createGatewayProcess`、`GATEWAY_READY_MESSAGE`、`DEFAULT_GATEWAY_ENTRY`、`validateGatewayOrigin`、`portInUse` |
| `qwen-audio-agent/gateway-lease` | `readGatewayLease`、`findRunningGateway`、`acquireGatewayLease` |
| `qwen-audio-agent/realtime-events` | `GatewayClientEvent`、`GatewayServerEvent`、`GatewayTaskEvent` |
| `qwen-audio-agent/gateway-events` | Gateway 事件 Zod Schema 与解析函数 |
| `qwen-audio-agent/ag-ui-events` | 当前支持的 AG-UI 兼容事件 Zod Schema 与解析函数 |
| `qwen-audio-agent/gateway-client-state` | `createGatewayClientState`、`reduceGatewayClientState`、`acceptsGatewayVoiceState` |
| `qwen-audio-agent/settings` | `createSettingsStore` |
| `qwen-audio-agent/skin-store` | `importSkin`、`listSkins`、`removeSkin`、`effectiveOrbSkin`、`skinsDirectory`、`validateSkinPackage` |
| `qwen-audio-agent/orb/main` | `bindOrbShell`、`configureOrbWindow`、`ORB_CHANNELS` |
| `qwen-audio-agent/orb/window` | `createOrbWindow`、`orbWindowOptions`、`ORB_PRELOAD_PATH`、`ORB_WINDOW_SIZE` |
| `qwen-audio-agent/orb/placement` | `createOrbPlacement`、`ORB_PLACEMENT_MARGIN` |
| `qwen-audio-agent/orb/presence` | `DesktopPresence` |
| `qwen-audio-agent/orb/preload` | 悬浮球与设置页共用的渲染进程 preload |
| `qwen-audio-agent/orb/url` | `desktopOrbUrl` |
| `qwen-audio-agent/web-dist/*` | 预构建的前端产物 |

除 `qwen-audio-agent/electron` 与 `qwen-audio-agent/orb/preload` 为
CommonJS（边界所需）外，其余均为 ESM。

## 嵌入流程

```js
const audioAgent = require('qwen-audio-agent/electron')
const api = await audioAgent.load()

const settings = api.createSettingsStore({ configDir })
if (!settings.ready()) { /* 展示 settings.status().missing，settings.save(...) */ }

const gateway = api.createGatewayProcess({ configDir, wakeWord: false })
const origin = await gateway.start()

const placement = api.createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: api.ORB_WINDOW_SIZE,
  loadState: () => settings.orbPosition.load(),
  saveState: state => settings.orbPosition.save(state),
})
const orb = await api.createOrbWindow({
  pageUrl: () => api.desktopOrbUrl(origin, { orbSkin: settings.load().orbSkin }),
  placement,
  partition: 'persist:my-host',
})
const presence = new api.DesktopPresence({ getWindow: () => orb.window() })
const shell = api.bindOrbShell({
  ipc: ipcMain,
  getWindow: () => orb.window(),
  presence,
  onDragEnd: () => {
    const [x, y] = orb.window().getPosition()
    placement.recordPosition({ x, y })
  },
  onQuit: () => stopPlugin(),
})

// 导入皮肤并生效：
api.importSkin({ source, skinsRoot: api.skinsDirectory(configDir) })
settings.save({ orbSkin: 'firefly--lingxiaotian' })
await orb.load()
```

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 存活、能力探测与运行状态；含 `protocolVersion`、`capabilities`、`gatewayInstanceId`、`voiceConfigured`、`inputSuspension`、`voiceClients`、`backend` |
| `GET /api/memory` | 列出当前 owner 有界、Provider 无关的前台记忆文档 |
| `PATCH /api/memory` | 按 revision 精确编辑这些文档；版本过期返回 `409` |
| `POST /api/input/suspend` | 抢占麦克风：`{ owner, reason?, ttlMs? }`，默认 15 秒，上限 300 秒 |
| `POST /api/input/resume` | 释放抢占：`{ owner }` |
| `GET /api/input` | 当前抢占状态 |
| `GET /api/tasks/:id/events?format=ag-ui` | 单个 Task 的可选 AG-UI `ACTIVITY_SNAPSHOT` 事件流；能力位：`tasks.ag-ui-event-stream` |

麦克风抢占的语义要点：**不要等回执**（按键到录音是延迟敏感路径，直接发送并
立即开始录音）；按 owner 幂等，重复宣告只刷新截止时间；多 owner 引用计数；
每个抢占都会过期，持有方崩溃或漏发 `resume` 也会自动恢复。

该接口只是 AG-UI 事件投射，不是完整的 AG-UI Agent/Run 端点。每个 Task 使用
稳定的 `messageId`，每次生命周期更新都会替换对应的 `qwen.audio.task` activity
内容。原生 Task 事件流仍是默认格式，现有客户端不会收到任何新增事件。

`/api/tasks`、`/api/permissions/:id`、`/api/conversations/:id/messages` 与
`/api/sessions/:id/replay` 从健康契约 `5.5.0` 起成为兼容别名：第一方 Client 已迁移到
6.0 WebSocket 命令与 `session.replay`。这些别名不会早于健康契约 `6.0.0` 删除。
`/api/backend/ui` 等未列出接口仍属内部实现，不承诺稳定。

## Realtime 事件

`WS /api/realtime?sessionId=<id>` 是公开的对话客户端边界。事件名通过
`qwen-audio-agent/realtime-events` 发布，消息 Schema 与解析器通过
`qwen-audio-agent/gateway-events` 发布；客户端应使用这些包入口，不依赖内部路径。
`gateway.connected` 与 `gateway.disconnected` 是共享状态 reducer 使用的客户端本地
生命周期辅助事件，不会通过 WebSocket 下发。

旧版 5.x 客户端在 WebSocket 打开后先发送 `connect`；该别名从健康契约 `5.5.0`
起废弃且不会早于 `6.0.0` 删除。6.0 客户端发送 `session.hello`，在同一信封中声明
连接配置，等待有关联关系的 `session.ready`，再按协商结果使用能力。握手用于声明输入/输出模式、客户端身份、语言/时区与
支持的输入类型。音频输入为 base64 PCM16 单声道，采样率取 `voice.ready` 返回的
`inputSampleRate`；音频输出按每个 `audio.delta` 携带的 `sampleRate` 播放。文本或
多模态轮次使用 `input.message`，按顺序提交 `text` / `file` 类型的 `parts`。Task
事件与对话事件共用同一连接，但只做对话的客户端可以忽略它们。

| 方向 | 事件组 | 含义 |
| --- | --- | --- |
| 客户端 → 服务端 | `session.hello` | 协议协商并声明客户端、连接配置及输入能力；`connect` 仅为废弃兼容别名 |
| 客户端 → 服务端 | `input.message`、`text.message` | 提交一轮文本或多模态对话输入 |
| 客户端 → 服务端 | `audio.append` | 追加一段 base64 PCM16 单声道音频 |
| 客户端 → 服务端 | `unmute`、`mute`、`input.unmute`、`input.mute` | 控制语音参与，或只控制麦克风采集 |
| 客户端 → 服务端 | `interrupt`、`sleep`、`wake` | 打断前台回复，或控制显式休眠 |
| 客户端 → 服务端 | `playback.started`、`playback.ended`、`playback.cancelled` | 按 `responseId` 回报客户端播放生命周期 |
| 服务端 → 客户端 → 服务端 | `client.action.request`、`client.action.result` | 执行 capability 约束的 Client Environment 操作并返回有关联结果 |
| 服务端 → 客户端 | `voice.ready`、`voice.connection`、`voice.ownership`、`voice.deactivated`、`voice.sleep` | 语音连接、占用权与休眠生命周期 |
| 服务端 → 客户端 | `turn.started`、`voice.state` | 前台对话轮次标识与状态 |
| 服务端 → 客户端 | `audio.delta`、`audio.done`、`playback.clear` | 播放音频流及清除指令 |
| 服务端 → 客户端 | `response.started`、`response.interrupted` | 以 `responseId` 标识的回复生命周期 |
| 服务端 → 客户端 | `transcript.delta`、`transcript.final`、`transcript.discard` | 用户与助手转写生命周期 |
| 服务端 → 客户端 | `task.*` | 可选的后台 Task 快照、进度、授权与完成事件 |
| 服务端 → 客户端 | `agent.activity`、`client.state`、`error` | 前台活动提示、临时保留的 5.x Client State 迁移别名与错误 |

| 方向 | 事件 | 含义 |
| --- | --- | --- |
| 服务端 → 客户端 | `input.suspend` | 立即停止采集（比用户级静音更强：不采集、不做唤醒词检测）；携带 `owner`、`reason`、`expiresAt` |
| 服务端 → 客户端 | `input.resume` | 可以恢复采集 |
| 客户端 → 服务端 | `input.suspend.ack` | 确认抢占已在本客户端生效 |
| 服务端 → 客户端 | `voice.state` | 前台语音轮次的表现状态：`idle`、`listening`、`processing` 或 `speaking`；同步前台工具调用期间保持 `processing`，直到终止结果或直连后续回复开始 |
| 服务端 → 客户端 | `transcript.final` | 最终助手转写可携带 `citations: [{ id, title, url, snippet?, source?, published_at? }]`；能力位：`messages.citations` |

### 共享客户端状态

`qwen-audio-agent/gateway-client-state` 将公开 Gateway 事件归并为无副作用的客户端
状态：`connectionState`、`voiceReady`、`voiceState`、`wakeWordActive`、
`ownership` 与 `currentTurnId`。`reduceGatewayClientState(state, event)` 对未知事件
保持原对象不变，
并统一忽略来自旧轮次的直连模型 `voice.state`；客户端仍自行处理音频播放、麦克风和
界面副作用，不应再复制这部分协议状态判断。锁定测试：
`test/gateway-client-state.test.mjs`。

`voice.state` 只描述前台 Realtime 轮次。后台 Agent 工作使用 Task 生命周期，不能从
`processing` 推断。等待审批同样是 Task 交互，而不是语音状态：客户端可以显示任务
卡片；需要语音询问时会自然进入 `speaking`。

## 实例租约

运行中的 Gateway 在其配置目录写入 `gateway.lock`：
`{ schema: "qwaudio.gateway-lock/v1", instanceId, pid, owner, state, origin,
startedAt, heartbeatAt }`。定位实例的方式：读租约、探活 `origin`、并核对
`/api/health` 回显的 `gatewayInstanceId` 是否一致——端口被其他进程复用时
读到的是"未运行"，而不是别人的状态。干净退出会释放租约。锁定测试：
`test/consumer-install.test.mjs`、`test/gateway-instance-lock.test.mjs`。

## 启动门禁（setup gate）

缺少必填的实时语音凭据（`DASHSCOPE_API_KEY`，或选择 Speech-to-Speech 时的
服务地址）时，`server/src/index.mjs` 在触碰租约之前即拒绝启动：进程以非零
退出，错误信息点名每一个缺失的键。`QWEN_AUDIO_ALLOW_UNCONFIGURED=1` 供
从不建立语音连接的调试场景显式跳过。锁定测试：`test/gateway-setup.test.mjs`、
`test/consumer-install.test.mjs`。

## 运行时基线

发布代码必须能在 `engines` 范围允许的最老 Node 上运行。CI 在该版本上实跑
测试套件，`test/runtime-baseline.test.mjs` 会在发布代码用到高于基线的 API
时让构建失败。
