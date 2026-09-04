# 座舱场景客户端

这是前台对话层中“客户自定义客户端”的参考实现，不是框架 WebUI 的派生版本，
也不是独立 Agent 层。它复用公开的 Gateway Client SDK 和 GCP 6.0，对浏览器麦克风、
Web Audio、3D 车辆与业务面板保持完全自主。

关键模块：

- `src/hooks/useVoiceSession.js`：GCP 连接、音频采集/播放、回执、Task 与最近对话恢复。
- `src/hooks/useCockpitState.js`：本示例的 HTTP/SSE 业务状态适配器。
- `src/hooks/useCockpitSkills.js`：按座舱读取、查看和删除持久化的自定义技能。
- `src/hooks/useGatewayMemory.js`：通过 Gateway 通用记忆控制面列出/删除前台记忆。
- `src/config/`：客户端拥有的人设展示和音色选项；不包含实际 Assistant Prompt。
- `src/projections/`：把 GCP/座舱 Service 事件投影为客户端展示状态。
- `src/App.jsx`：页面状态和对话/业务投影，不包含 Agent 或 Realtime Provider 逻辑。

“技能”设置页只负责展示和管理。技能创建与运行仍从语音对话进入 Gateway，
再通过固定的 `spawn_thinking` 桥梁交给后台座舱 Agent。
“记忆”设置页不创建独立座舱存储，而是管理 Realtime 实际使用的前台记忆文档。

从仓库根目录使用 `npm run example:smart-cockpit` 启动完整链路。单独开发 UI 时运行：

```bash
npm install
npm run dev
```

可选变量：`VITE_GATEWAY_ORIGIN`、`VITE_COCKPIT_SERVICE_ORIGIN` 和 `VITE_COCKPIT_ID`。默认值分别对应本地 Gateway、座舱 Service 和 `default` 座舱实例。
