# 扩展 qwen-audio-agent

运行时是通用的；一切场景相关的行为都通过声明好的接缝进入。本页列出全部
接缝，并指向对应的指南。

## 前台工具：MCP、OpenAPI、Profile

不碰语音链路即可给对话加工具：通过前台 MCP 客户端接入 MCP 服务、从
OpenAPI 3.x 文档暴露选定的 REST 操作，或把人设与工具配置打包成版本化的
前台 Profile。

→ [前台 MCP 客户端](reference/frontend-mcp.zh.md) ·
[前台 OpenAPI 适配器](reference/frontend-openapi.zh.md) ·
[前台 Profile](reference/frontend-profile.zh.md)

## 语音前台：自定义 Realtime Provider

把实时语音模型换成其他云服务或自有栈：实现 Provider 契约并注册进
Provider 注册表。

→ [自定义 Provider](voice-frontends/custom-provider.zh.md)

## 知识：检索 Provider

网关只定义一个很小的检索边界，不自带 RAG 栈——接入你已经在运营的
知识系统。

→ [知识检索 Provider](reference/knowledge.zh.md)

## 后台：接入新 Agent

四条路径把后台接到协议中立的 `BackendPort` 之后：零代码的通用 ACP
入口、远程 A2A 智能体、用 Backend Adapter SDK 编写的自定义适配器，
或带一键安装的一等公民后台。

→ [接入新后台](backends/extend.zh.md) ·
[Backend Adapter SDK](reference/backend-adapter-sdk.zh.md) ·
[A2A Backend Adapter](reference/a2a-backend-adapter.zh.md)

## 人设与记忆

助手的名称、人格和声音在 `ASSISTANT.md` 里；用户的长期事实在
`USER.md` / `MEMORY.md` 里。都是配置目录下的普通 Markdown，可以直接
编辑，网关自己则走受约束的写入路径。

→ [助手画像与用户偏好](reference/personalization.zh.md) ·
[长期记忆](reference/memory.zh.md)

## 客户端：自己构建

网关在单条 WebSocket 上讲类型化事件。按客户端协议构建自定义客户端，
或通过稳定性契约把助手嵌入宿主页面——桌面悬浮球、TUI、WebUI 用的都是
同一条通道。
[`examples/custom-conversation-client/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/custom-conversation-client)
是最小起点。

→ [Gateway 客户端协议](gateway-protocol.zh.md) ·
[稳定性契约](contract.zh.md)

## 桌面外观

桌面悬浮球渲染可替换的宠物皮肤：一个 `pet.json` 清单加一张精灵图。

→ [宠物皮肤规范](desktop/pet-skin-spec.zh.md)
