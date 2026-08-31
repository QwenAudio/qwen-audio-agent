# 替换场景组件

## 替换座舱 UI

客户 UI 不需要继承框架 WebUI，也不需要复制本示例页面。它只需：

1. 使用 `qwen-audio-agent/gateway-client-sdk` 或按 GCP 6.0 实现客户端。
2. 连接 Gateway 的 `/api/realtime`。
3. 自行实现音频采集、播放和 GCP 播放回执。
4. 按产品需要渲染 transcript、Task、权限和恢复的最近对话。

车辆总线和业务面板仍由客户自己的通道连接。`react-app/src/hooks/useVoiceSession.js` 是浏览器接入参考，`useCockpitState.js` 只是本示例的业务状态适配器。

## 替换后台 Agent

示例 Agent 是约 300 行的轻量 A2A 服务，只用于证明协议和领域调用链。正式场景可以使用任意 Agent 框架或既有行业 Agent：

- 发布标准 A2A Agent Card，并在 `COCKPIT_AGENT_CARD_URL` 中填写地址；或
- 在 `gateway.mjs` 的装配点替换为 ACP Adapter；或
- 实现 BackendPort 后通过 `createBackendAgentHost` 注入自定义协议。

替换后台不需要修改 GCP 客户端、Realtime 前台或领域服务。后台只需把适合对话的进度、权限请求和最终结果返回 Gateway；其他业务输出可继续走客户自己的系统。

## 替换领域服务

`cockpit-domain` 不是框架要求，而是“单一业务状态源”的示例。客户可以让后台 Agent 直接调用真实车辆、CRM 或订单系统。若希望 UI 与 Agent 复用同一能力，建议保留两个轻量边界：

- 给 Agent 的 MCP 工具面；
- 给 UI 的业务状态投影面（HTTP/SSE、消息总线或客户协议）。

不要把场景对象塞入 Gateway，也不要恢复 `actions[]` 作为隐式 UI 控制协议。

## 增加或调整工具

`tools/` 中每个目录是一个领域工具包：`manifest.json` 定义 MCP 工具，`execute.mjs` 实现场景逻辑。将工具包加入 `registry.mjs` 的 `FRONTEND_TOOL_GROUPS` 或 `BACKEND_TOOL_GROUPS` 即可决定调用面。这是代码层的明确修改点，不是新的动态插件框架。
