# 座舱示例架构

本示例是 qwen-audio-agent 前后台基础架构在智能座舱领域的完整实现：

- **前台对话层**由 `cockpit-client` 与 `cockpit-gateway` 组成。客户端是可替换
  I/O 组件，Gateway/Realtime 是复用的框架核心。
- **后台执行层**由 `cockpit-agent` 示范。Qwen3.8-Flash 负责理解任务、选择工具和
  多轮执行，工具通过后台 MCP 面发现和调用。后台 Agent 也可按需派生独立 Session，
  形成由第二层扩展出的第三层执行空间；当前示例未采用派生 Session。
- `cockpit-service` 是 Demo 为同时驱动 UI 和工具而提供的场景基础设施，不属于
  qwen-audio-agent 的层级模型。

早期座舱原型只提供了可复用的界面代码和视觉资源；下面的运行链路基于当前框架
公开协议重新实现，不承担旧架构兼容。

## 代码边界与依赖方向

| 目录 / 入口 | 性质 | 允许依赖 | 不应承担 |
|---|---|---|---|
| `client/` | 前台客户端示例 | GCP Client SDK、座舱 Service HTTP/SSE | Realtime Provider、后台 Agent 实现、业务执行 |
| `gateway/` | 前台 Agent 与 Gateway 装配 | qwen-audio-agent 公开导出、场景 Profile、A2A Agent Card | 复制 Gateway 核心、解析座舱业务对象 |
| `agent/` | 模型驱动的后台 Agent 示例 | DashScope、A2A SDK、`/mcp/backend` | UI 控制、Realtime 会话、场景状态存储 |
| `service/` | 座舱环境与基础设施 | `service/tools/`、场景状态与规则、外部服务适配、HTTP/SSE/MCP Transport | 对话、播报、Agent 编排 |
| `bootstrap/` | 本地示例启动支持 | `.env.local`、端口探测 | 对话、业务状态或 Agent 行为 |

运行时依赖始终从客户端指向公开 Gateway 协议、从 Gateway 指向公开 BackendPort，
不会从示例反向引用框架内部源码。测试可以直接引用内部实现做契约验证，但这不是
生产运行依赖。

## 四个独立进程

```text
cockpit-client ── GCP 6.0 ──► cockpit-gateway ── A2A ──► cockpit-agent
      │                          │                         │
      │ HTTP/SSE                │ frontend MCP            │ backend MCP
      │ 业务状态                 │ 天气/车况/车窗/大灯       │ 完整工具面/自定义技能
      ▼                          ▼                         ▼
                         cockpit-service
                         单一场景状态与工具执行
```

这里不存在“框架 WebUI”。`client` 是客户场景客户端的参考实现，它直接使用
公开的 `qwen-audio-agent/gateway-client-sdk`，并自行负责浏览器麦克风、音频播放、
页面布局和业务面板。客户端与 Gateway 是前台内部组件关系，而非独立 Agent 层。

## 对话面与业务面

对话面只经过 GCP：音频输入、文本输入、转写、回复音频、播放回执、Task、权限和最近会话恢复都由 Gateway 统一处理。座舱客户端不再访问旧 `/api/chat/stream` 或 `/api/voice/realtime`。

业务面属于场景自身：

- `cockpit-service` 是车辆、导航、音乐、天气和闪购状态的唯一来源。
- UI 通过 HTTP 获取快照、执行面板操作，通过 SSE 接收状态变化。
- Gateway 的前台 Agent 通过 `/mcp/frontend` 直接使用天气、车辆位置、车况、单次车辆控制、
  停止导航、导航视图/播报/偏好和音乐播放控制工具；明确的低延迟指令直接执行。
- `service/vehicle-location.mjs` 将车机定位收敛为单一适配边界：位置查询、导航起点和
  “当前位置”收藏都使用同一状态，未接真实定位时才使用带来源标记的 Demo 回退。
- 后台 Agent 通过 `/mcp/backend` 使用完整工具面，支持组合任务以及自定义技能的
  发现、创建、加载和执行。
- 两个工具面由 `service/tools/registry.mjs` 显式组合，但共用同一份执行器和座舱状态；
  前台工具是完整后台能力上的低延迟快路径，不是另一份业务实现。
- Gateway 不接收 `actions[]`，也不理解车辆、路线、媒体或订单结构。

因此后台任务还可以把详细状态发送给客户自己的座舱系统；Gateway 只接收适合继续对话和播报的 Task 进展与结果。

记忆属于前台对话面，不属于座舱 Service。客户端的记忆列表/删除面板使用
Gateway `GET/PATCH /api/memory` 控制面，与 Realtime 记忆工具共用同一个
`MemoryProvider`；默认 Markdown 与外部 Provider 对客户端是同一份协议。

## 自定义技能

座舱自定义技能是用户通过语音保存的场景工作流。记录由 `cockpit-service` 按
`cockpitId` 持久化，UI 通过场景 HTTP/SSE 展示；前台只负责把创建或运行意图经
`spawn_thinking` 交给后台。后台 Agent 每次任务读取精简目录，命中后调用
`custom_skill_load`，再用已有 MCP 工具逐步执行。

这里不会为每个技能动态注册 MCP Tool，也不会修改 A2A Agent Card。它与通过
`qwenaudio skill install` 安装给开发者后台的 Agent Skills 是不同概念。

## 场景装配

`gateway/server.mjs` 是唯一的前台场景装配点：它通过公开入口创建 A2A Backend Adapter、
Backend Agent Host 和 Gateway Application。完整前台人设集中在 `gateway/assistant/`，
`gateway/frontend-profile.json` 指向默认的 `healer.md`。客户端在自己的
`client/src/config/personas.js` 中维护展示项，只发送 Profile ID；Gateway 的
`assistant/event.mjs` 独立校验 ID 并加载可信 Markdown。Gateway 等当前回复空闲后通过现有
`session.update` 刷新同一个 Realtime Session，不重连、不重写 Markdown。

人设文件只定义身份、人格与表达风格。前台工具选择规则属于 MCP description/schema，
后台任务边界属于 `gateway/spawn-thinking-tool.mjs`。这些装配均没有复制框架核心，
也没有引入座舱专用框架分支。

四个进程的默认端口只用于本地示例，可通过 `.env.local` 覆盖。`COCKPIT_ID` 用于隔离不同座舱实例，UI 与 Agent 必须使用同一个值。
