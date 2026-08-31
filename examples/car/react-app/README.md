# 座舱场景客户端

这是前台对话层中“客户自定义客户端”的参考实现，不是框架 WebUI 的派生版本，
也不是独立 Agent 层。它复用公开的 Gateway Client SDK 和 GCP 6.0，对浏览器麦克风、
Web Audio、3D 车辆与业务面板保持完全自主。

关键模块：

- `src/hooks/useVoiceSession.js`：GCP 连接、音频采集/播放、回执、Task 与最近对话恢复。
- `src/hooks/useCockpitState.js`：本示例的 HTTP/SSE 业务状态适配器。
- `src/App.jsx`：页面状态和对话/业务投影，不包含 Agent 或 Realtime Provider 逻辑。

从仓库根目录使用 `npm run example:car` 启动完整链路。单独开发 UI 时运行：

```bash
npm install
npm run dev
```

可选变量：`VITE_GATEWAY_ORIGIN`、`VITE_COCKPIT_DOMAIN_ORIGIN` 和 `VITE_COCKPIT_ID`。默认值分别对应本地 Gateway、Domain 和 `default` 座舱实例。
