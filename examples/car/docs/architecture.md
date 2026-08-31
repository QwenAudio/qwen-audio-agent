# 座舱示例架构

## 四个独立进程

```text
┌──────────────────────────┐       GCP 6.0        ┌──────────────────────────┐
│ cockpit-client           │◄────────────────────►│ cockpit-gateway          │
│ React UI + Browser Audio │  transcript/audio/   │ qwen-audio-agent Gateway │
│                          │  Tasks/receipts       │ + 前台 Realtime Agent     │
└────────────┬─────────────┘                       └────────────┬─────────────┘
             │ HTTP/SSE                                          │ BackendPort
             │ 业务状态与面板操作                                  │ A2A
             ▼                                                   ▼
┌──────────────────────────┐          MCP          ┌──────────────────────────┐
│ cockpit-domain           │◄─────────────────────│ cockpit-agent            │
│ 单一领域状态与能力         │                       │ 轻量示例后台 Agent         │
└──────────────────────────┘                       └──────────────────────────┘
```

这里不存在“框架 WebUI”。`react-app` 是客户场景客户端的参考实现，它直接使用公开的 `qwen-audio-agent/gateway-client-sdk`，并自行负责浏览器麦克风、音频播放、页面布局和业务面板。

## 对话面与业务面

对话面只经过 GCP：音频输入、文本输入、转写、回复音频、播放回执、Task、权限和最近会话恢复都由 Gateway 统一处理。座舱客户端不再访问旧 `/api/chat/stream` 或 `/api/voice/realtime`。

业务面属于场景自身：

- `cockpit-domain` 是车辆、导航、音乐、天气和闪购状态的唯一来源。
- UI 通过 HTTP 获取快照、执行面板操作，通过 SSE 接收状态变化。
- 后台 Agent 通过 MCP 使用同一组领域能力。
- Gateway 不接收 `actions[]`，也不理解车辆、路线、媒体或订单结构。

因此后台任务还可以把详细状态发送给客户自己的座舱系统；Gateway 只接收适合继续对话和播报的 Task 进展与结果。

## 场景装配

`gateway.mjs` 是唯一的场景装配点：它通过公开入口创建 A2A Backend Adapter、Backend Agent Host 和 Gateway Application。场景人设集中在 `ASSISTANT.md`，没有引入策略注册表或座舱专用框架分支。

四个进程的默认端口只用于本地示例，可通过 `.env.local` 覆盖。`COCKPIT_ID` 用于隔离不同座舱实例，UI 与 Agent 必须使用同一个值。
