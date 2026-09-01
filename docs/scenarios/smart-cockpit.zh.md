# 智能座舱

[`examples/smart-cockpit/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/smart-cockpit) 是基于 qwen-audio-agent 前后台边界的可运行座舱参考场景。它保留车机界面、浏览器语音、车控、导航、音乐、天气和闪购体验，但不再维护独立 Realtime Server 或前台对话历史；后台模型循环位于可替换的 `agent/` 进程。

## 组件对应关系

| 组件 | 示例实现 | 可替换边界 |
|---|---|---|
| `client/` | React 座舱 UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| `gateway/` | qwen-audio-agent Gateway + 前台 Realtime Agent | 复用框架核心并进行场景装配 |
| `agent/` | Qwen3.8-Flash 驱动的 A2A 座舱 Agent | BackendPort / A2A / ACP / 定制 Adapter |
| `service/` | 座舱环境、状态、规则、工具和外部服务适配 | HTTP/SSE / MCP / 客户协议 |

座舱 Service 独立维护车辆、路线、媒体和订单状态。UI 通过 HTTP/SSE 展示，前台和后台 Agent 通过受限 MCP 工具面调用；Gateway 不解析场景对象，也不承担业务状态总线。

示例也支持通过语音创建和运行按座舱持久化的自定义技能。后台 Agent 加载技能工作流后编排现有 MCP 工具；不会为用户技能动态修改 Gateway 协议、MCP 工具集或 A2A Agent Card。

前台还支持在当前 Realtime Session 中切换“聊愈师 / 行动派 / 疯批”。客户端通过
GCP Client Event 只发送白名单 ID，Gateway 映射到 `gateway/assistant/` 下部署方拥有的 Markdown，
再以 `session.update` 对下一轮生效；不允许客户端注入任意 Prompt。

这说明客户通常只保留框架的对话中控：座舱 UI 和后台 Agent 都可以换成自己的实现。客户 UI 不需要继承框架 WebUI，只需实现 GCP 客户端和自己的音频、页面及业务状态通道。

## 运行

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
# 在 .env.local 中填写 DASHSCOPE_API_KEY；地图 Key 可选
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

打开 `http://localhost:5173`。一条命令会同时启动 service、agent、gateway 和 client。

完整架构、组件替换方式和测试矩阵见 [`examples/smart-cockpit/README_ZH.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/README_ZH.md)。
