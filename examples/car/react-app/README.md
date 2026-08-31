# Qwen Audio Agent Car 前端

这是 Qwen Audio Agent Car 的 React + Vite 场景客户端。它负责车机 UI、VoiceDock、浏览器麦克风采集、音频播放和调试面板，不依赖框架 WebUI。

对话通过公开的 Gateway Client Protocol 6.0 接入 qwen-audio-agent Gateway；车辆、导航、音乐、天气和闪购状态通过座舱领域服务的 HTTP/SSE 通道获取。Gateway 不解析这些座舱业务对象。

## 技术栈

- React 19
- Vite 8
- JavaScript
- Three.js / @react-three/fiber / @react-three/drei
- 单文件全局样式：`src/App.css`

## 启动

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:5173
```

构建和检查：

```bash
npm run build
npm run lint
```

## 主要模块

| 文件 | 说明 |
|---|---|
| `src/App.jsx` | 前端根状态、屏幕切换和场景状态投影 |
| `src/App.css` | 全局样式、Dock、VoiceDock、调试面板、应用页样式 |
| `src/components/VehiclePanel.jsx` | 车辆主界面和 VoiceDock 容器 |
| `src/components/VoiceDock.jsx` | 语音 Dock 布局、麦克风、灵魂选择、设置入口 |
| `src/components/VoiceWave.jsx` | Canvas 光场动效，响应 listening / thinking / speaking / progress |
| `src/hooks/useVoiceSession.js` | 麦克风采集、WebSocket、PCM 播放、语音事件归一 |
| `src/hooks/useCockpitState.js` | 座舱领域状态快照、SSE 更新和直接操作 |
| `src/components/ChatPanel.jsx` | 文本和语音统一调试面板 |
| `src/components/MapPanel.jsx` | 地图和导航状态 |
| `src/components/MusicPanel.jsx` | 音乐应用 |
| `src/components/FlashBuyPanel.jsx` | 淘宝闪购应用 |
| `src/components/SettingsPanel.jsx` | 灵魂、音色、路线策略、技能、记忆设置 |
| `src/components/Dock.jsx` | 底部车机 Dock |
| `src/components/TopBar.jsx` | 顶栏时间、天气和状态 |

## 语音链路

`useVoiceSession` 只连接对话中控：

```text
WS /api/realtime?sessionId=...
```

职责：

- 请求麦克风权限。
- 将输入音频转换为 16 kHz mono PCM16。
- 接收 24 kHz PCM 音频并排队播放。
- 发送 GCP `playback.started` / `playback.ended` / `playback.cancelled` 回执。
- 输出 `voiceState`、`inputLevel`、`outputLevel` 给 `VoiceDock`。
- 将标准 transcript 和 Task 事件归一为 ChatPanel 消息，并通过 GCP 恢复最近对话。

`useCockpitState` 独立连接 `cockpit-domain`：

```text
GET  /api/cockpit/state
GET  /api/cockpit/events
POST /api/cockpit/commands
```

语音任务和面板直接操作共享同一个领域状态源，不通过对话事件传递 `actions[]`。

## UI 状态约定

- 主屏：车辆 3D + 地图辅助信息。
- 音乐屏：QQ 音乐风格播放器。
- 闪购屏：淘宝闪购外卖/奶茶伪下单。
- 设置屏：灵魂、音色、路线策略、技能和记忆。
- 调试面板：默认打开时位于右侧 1/3，文本和语音共用同一展示结构。

VoiceDock 的主提示文案是“说吧，想做什么？”。有任务进度时会显示对应阶段，例如“正在查找目的地”“正在规划路线”“正在查找附近可送商品”。

## 本地体验注意

- `localhost` 可以直接使用浏览器麦克风。
- 局域网 IP 访问通常需要 HTTPS 或浏览器允许不安全源，否则麦克风权限会被拦截。
- `VITE_GATEWAY_ORIGIN` 可指定 Gateway 地址；开发代理默认指向 `http://127.0.0.1:18888`。
- `VITE_COCKPIT_DOMAIN_ORIGIN` 可指定领域服务地址，默认 `http://127.0.0.1:3010`。
- 前端只感知 GCP，不感知具体 Realtime provider 或后台 Agent。
