# Server source map / 服务端代码导航

Directories follow feature ownership. Contracts, runtimes, and concrete adapters
stay separate inside their domain; `app/` assembles them through dependency
injection. Moving code does not change public package exports or wire protocols.

按功能归属组织目录，模块内部区分接口、运行时和具体实现；`app/` 负责装配与依赖
注入。源码位置不等于公共接口，扩展方应使用包导出的入口。

| Directory / 目录 | Responsibility / 职责 |
| --- | --- |
| `app/` | Application assembly, lifecycle and cross-domain wiring / 应用装配、生命周期与跨模块连接 |
| `frontend/` | Chatbot instructions, tools and web retrieval / 前台指令、工具与网页检索 |
| `voice/` | Realtime connections, audio turns and presentation / Realtime 连接、音频轮次与播报 |
| `backend/` | BackendPort and protocol-neutral execution / 后台通用接口与执行；`adapters/` 实现 ACP、A2A |
| `memory/` | Long-term memory, preference learning and providers / 长期记忆、偏好学习与记忆 Provider |
| `knowledge/` | Knowledge contracts, retrieval and ingestion / 知识库接口、检索与入库；`providers/local/` 为内置实现 |
| `conversation/` | Conversation projection, context composition, notes and summaries / 对话投影、上下文组装、清单与摘要 |
| `session/` | Durable event journal and replay / 会话事件持久化与回放 |
| `task/` | Task lifecycle, scheduling and permission policy / 任务生命周期、调度与授权策略 |
| `client/` | Client commands, actions, presence and connection ownership / 客户端命令、动作、在线状态与连接归属 |
| `transport/` | Gateway Client Protocol encoding and projections / 网关客户端协议编解码与投影 |
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

Memory learning uses injected `onAudio` / `onSessionClosed` observers. The voice
transport publishes lifecycle facts without knowing learning policy; shutdown
drains asynchronous hooks before closing modules. This extraction currently
covers memory and knowledge, not arbitrary deletion of every source directory.

记忆学习通过注入的 `onAudio` / `onSessionClosed` 观察器工作。语音传输层只发布
生命周期事实，不了解学习策略；关闭时先等待异步观察完成，再关闭模块。
目前已落实并验证的是记忆和知识库，不表示任意源码目录都可以直接删除。

Dependency rules are enforced by / 依赖边界由以下测试校验：
[`server/test/dependency-boundaries.test.mjs`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/test/dependency-boundaries.test.mjs).

Physical removal is tested in temporary copies with a real Gateway and a mock
Realtime service / 在临时副本中真实删除目录，并通过网关与模拟 Realtime 完成对话验证：
[`server/test/optional-modules-pruning.test.mjs`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/test/optional-modules-pruning.test.mjs).
