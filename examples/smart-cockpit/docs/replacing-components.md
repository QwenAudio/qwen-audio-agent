# 替换场景组件

这些替换点围绕“前台对话 + 后台执行”两层设计。UI 是前台的客户端组件；座舱服务
是客户业务基础设施；二者都不是额外的 Agent 层。

## 替换座舱 UI

客户 UI 不需要继承框架 WebUI，也不需要复制本示例页面。它只需：

1. 使用 `qwen-audio-agent/gateway-client-sdk` 或按 GCP 6.0 实现客户端。
2. 连接 Gateway 的 `/api/realtime`。
3. 自行实现音频采集、播放和 GCP 播放回执。
4. 按产品需要渲染 transcript、Task、权限和恢复的最近对话。

车辆总线和业务面板仍由客户自己的通道连接。`client/src/hooks/useVoiceSession.js` 是浏览器接入参考，`useCockpitState.js` 只是本示例的业务状态适配器。

如果客户 UI 需要保留人设切换，它应声明 `client.events` capability，并发布
`cockpit.assistant_profile.selected`；payload 只包含 `gateway/assistant/event.mjs`
允许的 Profile ID。客户端展示项位于 `client/src/config/personas.js`，实际 Prompt
位于 Gateway，两者不共享实现代码。
不应由客户端上传 Prompt 或文件路径。不需要该功能的 UI 可以完全不实现这个场景事件。

## 替换后台 Agent

示例 Agent 是由 Qwen3.8-Flash 驱动的真实 A2A Agent：模型理解任务，通过 MCP
发现工具，可以连续完成多个工具调用。正式场景仍可使用任意 Agent 框架或既有行业 Agent：

- 发布标准 A2A Agent Card，并在 `COCKPIT_AGENT_CARD_URL` 中填写地址；或
- 在 `gateway/server.mjs` 的装配点替换为 ACP Adapter；或
- 实现 BackendPort 后通过 `createBackendAgentHost` 注入自定义协议。

替换后台不需要修改 GCP 客户端、Realtime 前台或座舱服务。后台只需把适合对话的
进度、权限请求和最终结果返回 Gateway；其他业务输出可继续走客户自己的系统。
后台是否使用工具、技能、子 Agent 或派生 Session，由后台自行决定。

## 替换座舱服务

`cockpit-service` 不是框架要求，而是“单一业务状态源”的示例。客户可以让后台 Agent 直接调用真实车辆、CRM 或订单系统。若希望 UI 与 Agent 复用同一能力，建议保留两个轻量边界：

- 给 Agent 的 MCP 工具面；
- 给 UI 的业务状态投影面（HTTP/SSE、消息总线或客户协议）。

不要把场景对象塞入 Gateway，也不要恢复 `actions[]` 作为隐式 UI 控制协议。

## 增加或调整工具

`service/tools/` 中每个目录是一个场景领域工具包：`manifest.json` 定义 MCP 工具，
`execute.mjs` 实现场景逻辑。在 `service/tools/registry.mjs` 注册领域工具包后，将适合
低延迟直出的工具名加入 `FRONTEND_TOOL_NAMES`，并在 `gateway/frontend-mcp.json`
启用对应的前台消费项；后台仍保留完整工具面用于组合任务。
同一个领域可以跨两个工具面，但只保留一份 executor 和状态源。这是代码层的明确
修改点，不是新的动态插件框架。

用户自定义技能同样属于场景实现：持久化和 MCP 契约位于 `service/`，理解与编排
位于可替换的 `agent/`，客户端只消费列表、详情和变更事件。替换后台 Agent 时可以
继续使用这组固定工具，也可以完全换成客户自己的工作流系统，无需修改 Gateway。
