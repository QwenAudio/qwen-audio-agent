# 智能座舱

仓库内置了一个可运行的智能座舱示例
[`examples/car/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/car)。
它把车机界面、实时语音、文本 Agent、车控、导航、音乐、闪购、天气、联网查询、
记忆和用户自定义技能组合成一个完整 Demo——是把语音 Agent 放进非编码环境的一份
具体参考。

示例刻意保持自包含：它复用 qwen-audio-agent 的实时语音与 Agent 模式，但自带
服务端，核心运行时保持通用、不含任何座舱专有逻辑。

## 与三层抽象的对应

| 层 | qwen-audio-agent | 座舱示例 |
| --- | --- | --- |
| 客户端（环境本身） | 桌面悬浮球 / TUI / WebUI | React 座舱 UI：VoiceDock、地图、音乐、车辆面板 |
| 网关（对话层） | Realtime 网关 + 前台 Agent | `server/voice/realtime.mjs`——Realtime Provider 前的 WebSocket 网关 |
| 后台（执行层） | ACP 后台 Agent | `server/agent.mjs`——编排技能的 DashScope 对话 Agent |

适配座舱 = 换客户端（车机 UI 替换桌面球）+ 换执行层（领域技能替换编码 Agent），
语音对话模式——全双工、打断、任务委派、进度播报——保持不变。

## 值得复用的设计模式

- **Realtime 模型保持轻量。** 它只负责音频交互和轻量路由；真正的工作通过唯一的
  `route_to_car_agent` 函数调用委派给 Agent，语音层不重新实现任何领域工具。
- **能力分层。** 原子工具（车控、导航、音乐 API）对模型隐藏；只暴露粗粒度的内置
  技能（`vehicle_control`、`navigation`、`music`、`flashbuy`、`weather`、
  `web_search`）和基础系统工具。自定义技能是用户用自然语言创建的 Markdown
  流程，执行时经 `skill_run` 加载。
- **适合语音的进度反馈。** 技能通过 `speakPolicy`（`always` / `if_slow` /
  `silent`）上报分阶段进度，座舱只播报值得说的内容（"正在规划路线"），调试面板
  能看到全部。
- **强制路由。** 对明确意图在首轮强制 `tool_choice`，避免模型用纯文本回答车控
  请求。
- **UI actions 回流。** 工具结果产出 `actions[]`，在语音回复的同时驱动座舱面板
  （地图预览、播放器、购物车）。

## 运行

在仓库根目录执行：

```bash
# 1. 配置 Key
cp examples/car/.env.example examples/car/.env.local
# 填写 VITE_AMAP_KEY / VITE_AMAP_SECRET / AMAP_MCP_KEY / DASHSCOPE_API_KEY

# 2. Agent 服务端（http://localhost:3001）
npm install --prefix examples/car/server
npm run example:car:server

# 3. 座舱 UI（http://localhost:5173）
npm install --prefix examples/car/react-app
npm run example:car:web
```

## 延伸阅读

示例自带完整设计文档：

- [系统架构](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/system-architecture.md)
- [Agent 设计](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/agent-design.md)
- [工具与技能设计](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/tools-and-skills.md)
- [语音交互设计](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/voice-interaction-design.md)
