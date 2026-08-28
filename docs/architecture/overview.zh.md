# 架构总览

qwen-audio-agent 是一个实时语音运行时，让 AI Agent 持续交流、持续工作、持续在场。
整体分为三层，层与层之间只有两个协议面。

![三层架构](../qwen-audio-agent-three-layer-architecture.png)

## 三层模型

1. **客户端——环境本身。** TUI、WebUI、桌面悬浮球，或你自己的客户端。
   客户端拥有 I/O 与展示，上报环境状态（窗口焦点、在场、休眠/唤醒），
   承载用户信号。用户如何唤醒助手（唤醒词、快捷键、点击）完全是客户端的事。
   客户端不持有记忆，只转发信号。

2. **网关——对话层与状态平面。** 一个进程内的两部分：
   - **Realtime 前台**是轻量语音智能体：全双工对话、即时回答，
     配一套刻意收敛的对话工具（搜索、记忆、提醒与工作控制）。
   - **Gateway 控制平面**是确定性的——路由路径上不额外引入 LLM。
     它掌管任务台账、权限裁决、播报策略，以及前后台之间的注入防线。

3. **后台——执行层。** 任何 `BackendPort` 之后的执行体：ACP 智能体
   （OpenCode、OpenClaw、Qoder、Qwen Code、Kimi Code、Claude Code、
   Codex、DeepSeek、Pi，或你自己的）、远程 A2A 智能体，或用 Backend
   Adapter SDK 编写的自定义适配器。ACP 接入通过固定协调 Session 保持工作的
   连续性；后台内部的工具、技能、子会话都是后台私有实现，不会变成新的层。

## 只有两个协议面

- **客户端 ↔ 网关**——[稳定性契约](../contract.zh.md)与
  [客户端协议](../gateway-protocol.zh.md)：单条 WebSocket 上的类型化事件。
- **网关 ↔ 后台**——`BackendPort`。协议细节留在 ACP、A2A 或自定义适配器
  内部；启动与能力行为由注册的 driver 承载。见[支持的后台](../backends/overview.zh.md)
  与 [Backend Adapter SDK](../reference/backend-adapter-sdk.zh.md)。

把运行时适配到新场景 = 换客户端（环境）+ 换后台（操作环境的工具）。
网关只通过声明式接缝变化：人设文件、播报策略、前台 MCP 工具与 OpenAPI
操作、知识/记忆 Provider。见[场景示例](../scenarios/smart-cockpit.zh.md)。

## 非阻塞循环

当请求需要真正干活时，前台调用 `spawn_thinking`，对话立即继续——
任务在后台会话里异步执行，结果在安全的插入窗口自然回流到同一场对话。
语音链路上的任何环节都不会等待后台。

## 继续阅读

- [详细架构](deep-dive.zh.md)——产品边界不变量：前台工具面、会话归属、
  工作状态、结果投递、进程归属与评审清单。
