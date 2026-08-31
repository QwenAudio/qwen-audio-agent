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

## 替换后台 Agent

示例 Agent 是由 Qwen3.8-Flash 驱动的真实 A2A Agent：模型理解任务，通过 MCP
发现工具，可以连续完成多个工具调用。正式场景仍可使用任意 Agent 框架或既有行业 Agent：

- 发布标准 A2A Agent Card，并在 `COCKPIT_AGENT_CARD_URL` 中填写地址；或
- 在 `gateway.mjs` 的装配点替换为 ACP Adapter；或
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

`service/tools/` 中每个目录是一个场景工具包：`manifest.json` 定义 MCP 工具，`execute.mjs` 实现场景逻辑。将工具包加入 `service/tools/registry.mjs` 的 `FRONTEND_TOOL_GROUPS` 或 `BACKEND_TOOL_GROUPS` 即可决定调用面。这是代码层的明确修改点，不是新的动态插件框架。
