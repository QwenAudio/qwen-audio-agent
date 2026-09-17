# 座舱示例架构

本示例是 qwen-audio-agent 前后台基础架构在智能座舱领域的完整实现：

- **前台对话层**由 `cockpit-client` 与 `cockpit-gateway` 组成，既负责实时对话，
  也直接调用前台工具。客户端是可替换 I/O 组件，Gateway/Realtime 复用框架核心。
- **后台执行层**由 `cockpit-agent` 示范。默认模型为 `qwen3.8-flash`，处理后台
  领域工具与新闻检索等异步任务；任务运行期间，前台仍可聊天和使用前台工具。
  多意图或多途经点本身不意味着必须委托后台。当前示例不派生独立 Agent Session。
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
cockpit-client ── GCP 7.0 ──► cockpit-gateway ── A2A ──► cockpit-agent
      │                          │                         │
      │ HTTP/SSE                │ frontend MCP            │ backend MCP
      │ 业务状态                 │ 车控/导航/音乐/天气/技能 │ 闪购
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
- Gateway 的前台 Agent 通过 `/mcp/frontend` 直接使用车控、导航、音乐、天气和
  自定义技能工具，默认共 37 个；路线规划与多途经点导航也在这条路径上。
- `service/vehicle-location.mjs` 将车机定位收敛为单一适配边界：位置查询、导航起点和
  “当前位置”收藏都使用同一状态，未接真实定位时才使用带来源标记的 Demo 回退。
- 后台 MCP 面默认只暴露 `flashbuy`。后台 Agent 另行组合框架的 `web_search`
  与 `fetch_url`，用于新闻简报或资料研究，不计入 Service 的 38 个场景工具。
- 两个 MCP 工具面按 `service/tools/surface-routing.json` 分领域配置，同一领域
  一次只暴露在一侧；并非“前台子集 + 后台全集”。它们共用执行器和座舱状态，
  调整执行位置不需要复制业务实现。详见[工具接入说明](../service/tools/README.md)。
- Gateway 不接收 `actions[]`，也不理解车辆、路线、媒体或订单结构。

因此后台任务还可以把详细状态发送给客户自己的座舱系统；Gateway 只接收适合继续对话和播报的 Task 进展与结果。

记忆属于前台对话面，不属于座舱 Service。客户端的记忆列表/删除面板使用
Gateway `GET/PATCH /api/memory` 控制面，与 Realtime 记忆工具共用同一个
`MemoryProvider`；默认 Markdown 与外部 Provider 对客户端是同一份协议。

## 自定义技能

座舱自定义技能由 `cockpit-service` 按 `cockpitId` 持久化，UI 通过场景 HTTP/SSE
展示。固定的列出、创建和加载工具默认由前台调用；加载工作流后，按步骤的实际工具
归属执行，仅将需要后台能力的部分委托后台。若显式把技能领域路由到后台，后台 Agent
才承担目录发现和加载。创建技能只保存定义，不等于立即执行。

温度提醒保存的是结构化条件与提醒内容：Service 检测温度从条件外进入条件内后发出
事件，由客户端转交前台自然播报，不需要让后台模型持续轮询。

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
