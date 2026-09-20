# 架构总览

qwen-audio-agent 将实时交流与异步执行连接起来。理解架构时，需要分开看核心组件的职责与服务的部署方式。

## 核心逻辑架构

| 组件 | 职责 | 边界 |
| --- | --- | --- |
| 前台 Agent（Frontend Agent） | 理解输入、自然交流，调用聊天工具或 `spawn_thinking`，根据结果组织回应。 | 由实时模型、提示词、上下文与工具构成；不处理后台原生协议和执行细节。 |
| 编排运行时（Orchestration Runtime） | 管理任务生命周期、权限、会话、事件与结果投递，让工作与对话并行。 | 通过代码执行调度和策略，不额外引入协调模型，也不替后台决定内部执行步骤。 |
| 后台 Agent（Backend Agent） | 在自己的执行环境中持续工作，使用自身模型、工具、MCP 和 Skills。 | 通过 `BackendPort` 接入；ACP、A2A 或自定义协议细节留在 Adapter 内。 |

这是三个逻辑组件，不要求分别部署成三个进程。后台内部的子 Agent 或独立 Session 也不会增加新的核心架构层。

## Gateway 与客户端

**Gateway 是框架的服务化运行形态。** 它装配编排运行时与前后台接入，提供监听、认证、连接管理和协议入口。编排运行时描述系统如何工作，Gateway 描述这些能力如何对外提供服务。Gateway 本身不是协议；客户端通信契约是 Gateway Client Protocol。

**客户端是交互与环境入口，不是前台 Agent。** 桌面版、WebUI、TUI、手机或自定义客户端负责 I/O、展示、用户操作及环境事件。唤醒词、快捷键、窗口和本地设备管理属于客户端；长期记忆由运行时接入的记忆模块管理。

部署时，桌面版可以启动内置 Gateway，也可以像手机、WebUI、TUI 一样连接独立部署的 Gateway。后台可以是受管的本机进程，也可以是 Adapter 支持的外部服务；这些部署差异不改变核心组件的职责。

## 接口边界

- **客户端 ↔ 网关**——[稳定性契约](../contract.zh.md)与
  [客户端协议](../gateway-protocol.zh.md)：默认使用单条 WebSocket 上的类型化事件；可选 [WebRTC 传输](../gateway-webrtc-client.zh.md)复用网关控制与生命周期。
- **编排运行时 ↔ 后台**——`BackendPort`。协议细节留在 ACP、A2A 或自定义适配器
  内部；启动与能力行为由注册的 driver 承载。见[支持的后台](../backends/overview.zh.md)
  与 [Backend Adapter SDK](../reference/backend-adapter-sdk.zh.md)。
- **运行时 ↔ 实时模型服务**——[Realtime Provider](../voice-frontends/custom-provider.zh.md)。供应商协议、认证与事件转换由独立适配器处理，不改变任务或客户端语义。

框架还提供人设、播报策略、前台 MCP/OpenAPI 工具与知识/记忆 Provider 等扩展入口。业务宿主通过现有应用入口装配，客户端通过 Gateway 接入。见[扩展指南](../extensions.zh.md)与[场景示例](../scenarios/index.zh.md)。

## 不要混淆的运行时与会话

- **编排运行时**是框架的逻辑组件。目前职责分布在 `task/`、`orchestration/`、`voice/` 等模块，由 `app/` 装配；不是一个同名类，也不只等于 `orchestration/` 目录。
- **前台会话运行时**管理一段实时对话的模型连接、上下文、工具与播报，是运行时实现的一部分。
- **后台协调 Session**是 ACP Adapter 使用的持久执行上下文，属于后台接入实现，不是编排运行时。A2A 或自定义后台不必采用这种会话结构。

## 非阻塞循环

当请求需要后台执行时，前台调用 `spawn_thinking`，编排运行时返回受理回执，对话可以继续。
任务由配置的后台异步执行，结果在安全的插入窗口自然回流到同一场对话。
后台执行不阻塞继续对话；权限与结果通过网关进入前台，按当前交互状态安排呈现。

## 继续阅读

- [详细架构](deep-dive.zh.md)——产品边界不变量：前台工具面、会话归属、
  工作状态、结果投递、进程归属与评审清单。
