# Server source map / 服务端代码导航

Directories follow feature ownership. Contracts, runtimes, and concrete adapters
stay separate inside their domain; `app/` assembles them through dependency
injection. Moving code does not change public package exports or wire protocols.

按功能归属组织目录，模块内部区分接口、运行时和具体实现；`app/` 负责装配与依赖
注入。源码位置不等于公共接口，扩展方应使用包导出的入口。

The logical architecture is **Frontend Agent — Orchestration Runtime — Backend Agent**.
Gateway is the service host that assembles runtime capabilities and exposes client access,
not another peer component or a protocol. Runtime responsibilities span several domains;
`orchestration/` is not the entire runtime, and an ACP backend's coordination Session is not the runtime.

核心逻辑架构是**前台 Agent — 编排运行时 — 后台 Agent**。Gateway 是装配运行时能力、
提供客户端接入的服务宿主，不是另一个并列组件或协议。运行时职责分布在多个功能模块中；
`orchestration/` 不等于全部编排运行时，ACP 后台的协调 Session 也不是编排运行时。

| Directory / 目录 | Responsibility / 职责 |
| --- | --- |
| `app/` | Application assembly, lifecycle and cross-domain wiring / 应用装配、生命周期与跨模块连接 |
| `frontend/` | Chatbot instructions, tools and web retrieval / 前台指令、工具与网页检索 |
| `voice/` | Frontend session runtime, audio turns and presentation / 前台会话运行时、音频轮次与播报 |
| `orchestration/` | Shared user Task operations and session-scoped delivery coordination / 共用用户任务操作与会话级投递协调 |
| `backend/` | BackendPort and protocol-neutral execution / 后台通用接口与执行；`adapters/` 实现 ACP、A2A |
| `memory/` | Long-term memory, preference learning and providers / 长期记忆、偏好学习与记忆 Provider |
| `knowledge/` | Knowledge contracts, retrieval and ingestion / 知识库接口、检索与入库；`providers/local/` 为内置实现 |
| `conversation/` | Conversation projection, context composition, notes and summaries / 对话投影、上下文组装、清单与摘要 |
| `session/` | Durable event journal and replay / 会话事件持久化与回放 |
| `task/` | Task lifecycle, scheduling and permission policy / 任务生命周期、调度与授权策略 |
| `client/` | Client commands, actions, presence and connection ownership / 客户端命令、动作、在线状态与连接归属 |
| `transport/` | Client connections, Gateway Client Protocol encoding and projections / 客户端连接、网关客户端协议编解码与投影 |
| `delivery/` | Provider-neutral AgentDelivery values / 与供应商无关的消息投递数据 |
| `access/` | Authentication, pairing and public endpoints / 访问认证、配对与公开地址 |
| `process/` | Local backend process ownership and launch drivers / 本机后台进程生命周期与启动驱动 |
| `core/` | Configuration, logging, storage, operation audit and small cross-domain utilities / 配置、日志、存储、操作审计与小型通用基础能力 |

Start with [MemoryProvider](memory/provider.mjs),
[KnowledgeProvider](knowledge/provider.mjs), [BackendPort](backend/backend-port.mjs)
or the [frontend tool catalog](frontend/frontend-tools.mjs).

Provider implementations live with their feature: memory in `memory/providers/`,
knowledge in `knowledge/providers/`, web search in `frontend/retrieval/providers/`,
MCP/OpenAPI tools in `frontend/tools/`, and Realtime in `voice/providers/`.
Business runtimes must not import concrete backend adapters or Realtime providers.

具体 Provider 跟随功能模块，不再设置跨业务的顶层 `providers/`。记忆不依赖对话或
语音实现，记忆与知识库各自提供工具入口；工具不依赖 Realtime 实现，通用后台不依赖
ACP/A2A Adapter。跨模块通过接口、参数和事件交互，不通过反向导入完成装配。

## Task orchestration / 任务协调

`app/` injects one `TaskOperations` into frontend tools and client commands.
It assembles owner queues, backend execution/cancellation, permission decisions
and input responses. Scheduled backend work uses the same execution and permission
path; system jobs and knowledge ingestion keep their own entry points.
`task/` remains the sole authority for state, persistence and scheduling.
Tool receipts and public command responses stay in their respective entry layers.

`app/` 将同一个 `TaskOperations` 注入前台工具和客户端命令，统一 owner 队列、
后台执行与取消、权限决定及补充输入。定时后台工作复用执行和权限链路；系统作业与
资料入库保留各自入口。`task/` 仍是状态、持久化和调度的唯一权威，工具回执与公开
命令响应分别留在各自入口层。

Each frontend connection owns a `SessionTaskCoordinator`: scoped Task observation,
pending permission/input delivery, notification claims and cleanup. It delegates
model text and response/playback behavior to `voice/realtime-task-presentation.mjs`
and the existing announcement managers. Task events reach the client only through
the transport projector. Closing a coordinator releases delivery claims, not work;
playback confirmation still controls when a notification becomes delivered.

每条前台连接拥有独立的 `SessionTaskCoordinator`，负责按 owner/session 观察任务、
协调权限与补充输入投递、领取结果通知和清理。模型文本与回复/播放行为留在
`voice/realtime-task-presentation.mjs` 和已有播报管理器中；任务事件经传输投影器发给客户端。
协调器关闭仅释放投递领取，不取消工作；通知仍由播放确认标记为已送达。

## Frontend session and transport / 前台会话与传输

`transport/gateway-client-transport.mjs` owns authentication, capability negotiation, connection
ownership, heartbeats, wire encoding and public event projection. Each admitted
connection uses its own `createRealtimeSessionRuntime` from
`voice/realtime-session-runtime.mjs`: model connection/context, tools, audio turns,
playback, recovery and client presence. The runtime receives decoded events and
trusted identity, emitting internal events through callbacks; it does not own a
socket, credentials or the Gateway Client Protocol handshake.

`transport/gateway-client-transport.mjs` 负责鉴权、能力协商、连接归属、心跳、协议编解码与公开事件投影。
每条接入连接使用独立的 `voice/realtime-session-runtime.mjs` 前台会话运行时，管理模型连接与
上下文、工具、音频轮次、播放、恢复和客户端休眠状态。运行时接收解码后的事件与可信身份，
通过回调发出内部事件，不持有 Socket、凭据或网关客户端协议握手。

`app/frontend-runtime.mjs` assembles the shared dependencies, initializes tool sources
once, creates per-connection sessions and drains lifecycle observers at shutdown.
The transport receives this runtime; it neither assembles tools nor resolves providers.
Tool-source services remain owned and closed by the application.

`app/frontend-runtime.mjs` 装配共用依赖、一次性初始化工具源，为每条连接创建独立会话，
退出时关闭会话并等待生命周期观察器完成。传输层只使用注入的运行时，不装配工具或解析
Provider；工具源服务仍由应用层持有和关闭。

Frontend interruption, mute, sleep and disconnection do not cancel accepted backend
work. Closing a runtime clears its timers, pending tools, subscriptions and delivery
claims; late provider callbacks cannot start new work. Only explicit task control
uses `TaskOperations.cancel`. `app/` remains the composition root; this is an internal
boundary, not a new service, wire protocol or shared model session.

前台打断、静音、休眠和断连不取消已受理的后台工作。关闭运行时会清理定时器、未完成的前台
工具调用、订阅和投递领取，迟到的模型回调不能再启动新工作；只有显式任务控制走
`TaskOperations.cancel`。`app/` 仍是组合根；这是内部边界，不新增服务、线上协议或共享模型会话。

[#477](https://github.com/QwenAudio/qwen-audio-agent/issues/477) is covered by direct
production-runtime tests with fake model/backend boundaries, plus existing
WebSocket/WebRTC integration tests. See
[`realtime-session-runtime.test.mjs`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/test/realtime-session-runtime.test.mjs).

[#477](https://github.com/QwenAudio/qwen-audio-agent/issues/477) 的测试直接调用生产运行时，仅模拟
模型与后台边界，并保留 WebSocket/WebRTC 集成测试；详见上述运行时测试。

## Removing an optional domain / 裁剪可选模块

Memory and knowledge each own their runtime assembly, providers, tools, HTTP
routes, and feature-specific instructions/context. Two explicit composition files
connect these domains; they are local wiring, not a plugin discovery protocol:

记忆和知识库各自拥有运行时装配、Provider、工具、HTTP 路由以及专属提示与上下文。
两处显式接线负责接入这些模块，不引入插件发现协议：

1. [`app/optional-modules.mjs`](app/optional-modules.mjs): runtime services, routes,
   lifecycle observers and cleanup / 运行时服务、路由、生命周期观察与关闭。
2. [`frontend/optional-features.mjs`](frontend/optional-features.mjs): tool schemas,
   handlers, availability and prompt/context contributions / 工具定义、执行、可用性与提示上下文。

To remove `memory/` or `knowledge/`, remove its import and array entry in both
files, then delete the domain directory. The Gateway still starts and serves
conversation; the removed tools and module routes are no longer exposed.
For a custom distributable, also remove that domain's package exports, dedicated
tests/docs and unused dependencies. Public protocol/configuration fields can
remain as unavailable capabilities; no changes to clients are required for basic chat.

删除 `memory/` 或 `knowledge/` 时，取消以上两处的对应 import 和数组项，再删除模块
目录即可。网关仍可启动并对话，不再提供该模块的工具和路由。如果制作精简发行包，
还应清理相应的包导出、专属测试/文档和闲置依赖。公共协议和配置字段可保留为未配置
能力，基本聊天不要求修改客户端。

Memory learning uses injected `onAudio` / `onSessionClosed` observers. The frontend
runtime publishes lifecycle facts without knowing learning policy; shutdown
drains asynchronous hooks before closing modules. This extraction currently
covers memory and knowledge, not arbitrary deletion of every source directory.

记忆学习通过注入的 `onAudio` / `onSessionClosed` 观察器工作。前台运行时只发布
生命周期事实，不了解学习策略；关闭时先等待异步观察完成，再关闭模块。
目前已落实并验证的是记忆和知识库，不表示任意源码目录都可以直接删除。

Dependency rules are enforced by / 依赖边界由以下测试校验：
[`server/test/dependency-boundaries.test.mjs`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/test/dependency-boundaries.test.mjs).

Physical removal is tested in temporary copies with a real Gateway and a mock
Realtime service / 在临时副本中真实删除目录，并通过网关与模拟 Realtime 完成对话验证：
[`server/test/optional-modules-pruning.test.mjs`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/test/optional-modules-pruning.test.mjs).
