# 智能座舱

[`examples/car/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/car) 是基于三层框架的可运行座舱参考场景。它保留车机界面、浏览器语音、车控、导航、音乐、天气和闪购体验，但不再维护独立 Realtime Server、对话历史或 Agent Loop。

## 三层对应关系

| 层 | 示例实现 | 可替换边界 |
|---|---|---|
| 客户端 | React 座舱 UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| 对话中控 | qwen-audio-agent Gateway + 前台 Realtime Agent | 复用框架核心 |
| 后台执行 | 轻量 A2A 座舱 Agent | BackendPort / A2A / ACP / 定制 Adapter |

领域服务独立维护车辆、路线、媒体和订单状态。UI 通过 HTTP/SSE 展示，后台 Agent 通过 MCP 调用；Gateway 不解析场景对象，也不承担业务状态总线。

这说明客户通常只保留框架的对话中控：座舱 UI 和后台 Agent 都可以换成自己的实现。客户 UI 不需要继承框架 WebUI，只需实现 GCP 客户端和自己的音频、页面及业务状态通道。

## 运行

```bash
cp examples/car/.env.example examples/car/.env.local
# 在 .env.local 中填写 DASHSCOPE_API_KEY；地图 Key 可选
npm run example:car:install
npm run example:car
```

打开 `http://localhost:5173`。一条命令会同时启动 domain、agent、gateway 和 client。

完整架构、组件替换方式和测试矩阵见 [`examples/car/README_ZH.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/README_ZH.md)。
