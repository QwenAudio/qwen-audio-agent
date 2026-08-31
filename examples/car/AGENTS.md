# Qwen Audio Agent Car — 项目指南

## 项目概览

Qwen Audio Agent Car 是 qwen-audio-agent 的智能座舱语音 Agent 示例。详见 README.md。

## 核心概念

### Tools

`server/tools/` 中保留跨领域的系统工具，例如时间、位置、记忆、提醒和自定义技能。车控、音乐、导航、闪购、天气和联网查询的最终 function 定义以 `server/domains/*.json` 为准，对应实现和业务约束放在 `server/domain-executors/*.mjs` 中。

代码位置：`server/tools/` 和 `server/amap-mcp.mjs`。

### Built-in Skills

系统内置的领域能力，对 LLM 暴露为 function calling。领域的 function schema 统一配置在 `server/domains/*.json` 中，它们就是各领域的最终原子函数定义；执行逻辑由 `server/domain-executors/*.mjs` 绑定。

代码位置：`server/domains/`、`server/domain-executors/` 和 `server/skills/builtin/index.mjs`。

长期目标：所有领域 function 都可以通过配置选择运行在 Realtime 侧或文本 LLM Agent 侧，并通过 harness 统一管理前后台路由、工具、记忆和 benchmark。详见 `docs/future-goals.md`。

当前 Built-in Skills：

- 车控：`vehicle_state_query`、`vehicle_window_control`、`vehicle_sunroof_control`、`vehicle_headlights_control`、`vehicle_climate_control`
- 导航：`navigation_start`、`navigation_route_query`、`navigation_stop`
- 音乐：`music_play`、`music_pause`、`music_next`、`music_previous`、`music_search`
- 闪购：`flashbuy`
- 天气：`weather`
- 联网查询：`web_search`

### Custom Skills

用户通过对话创建的自然语言编排。本质是一段 Markdown 指令（存储为 `SKILL.md`），描述一个多步骤任务流程。执行时由 `skill_run` 工具将指令注入给 LLM，LLM 按指令调用 Built-in Skills 或系统工具完成。

存储位置：`server/custom-skills/{clientId}/{技能名}/SKILL.md`。

示例：用户创建"下班回家"技能 → 存储指令（导航到家 + 播放音乐 + 关闭车窗 + 查询天气）→ 触发时 LLM 依次调用 `navigation_start`、`music_play`、`vehicle_window_control`、`weather`。

### Voice Realtime Provider

语音实时对话链路分为通用网关和统一的 DashScope Realtime provider：

- `server/voice/realtime.mjs` 是通用 WebSocket 网关，对前端暴露 `/api/voice/realtime`，负责音频转发、状态事件、Agent function call、调试信息和 UI actions 回流。
- `server/voice/providers/index.mjs` 是 provider 创建入口；当前实现是 `dashscope-realtime.mjs`，通过 DashScope 接入 Qwen-Audio-Realtime。
- 前端不选择 Realtime 模型；具体模型通过 `.env.local` 中的 `QWEN_AUDIO_REALTIME_MODEL` 配置。Audio 与 Omni 系列模型都走同一个 Realtime 协议和 provider 接口。
- provider 应保持网关依赖的接口语义：`connect`、`updateSession`、`appendAudio`、`sendFunctionOutput`、`speakProgress`、`close`。
- Realtime 入口模型注入当前时间、完整用户记忆、当前灵魂设定、最近 5 轮对话。完整工具上下文仍由 `chatStream()` 加载。
- Realtime 入口只暴露 `route_to_car_agent`。车控、导航、音乐、闪购、天气、联网查询、记忆、提醒、自定义技能和时间相关任务都必须路由到现有 Agent。
- 语音入口直接闲聊的 user/assistant 文本要写入统一 history；路由到 Agent 的任务不要重复写 history。

### 区别

| | Tools | Built-in Skills | Custom Skills |
|---|---|---|---|
| 创建者 | 开发者 | 开发者 | 用户 |
| 实现方式 | JavaScript 代码 | JSON function schema + JavaScript executor | Markdown 指令 |
| 存储 | `server/tools/*.mjs` | `server/domains/*.json` + `server/domain-executors/*.mjs` | `server/custom-skills/{clientId}/{技能名}/SKILL.md` |
| 执行 | LLM 可直接调用的系统基础能力 | LLM 直接 function call，executor 负责业务约束和实现 | `skill_run` 加载后由 LLM 解释执行 |
| 粒度 | 系统基础能力 | 按领域和意图拆分的最终原子函数 | 多能力流程 |

## 技术栈

- 前端：React 19 + Vite 8，JavaScript（不用 TypeScript）
- 3D：Three.js + @react-three/fiber + @react-three/drei
- 样式：单文件 `App.css`，不用 CSS Modules
- 路由：hash 路由，useState 管理，不用 React Router

## 开发命令

```bash
npm install --prefix examples/car/server
npm run example:car:server       # 启动 Agent 服务 (localhost:3001)

npm install --prefix examples/car/react-app
npm run example:car:web          # 启动开发服务器 (localhost:5173)
npm run example:car:build        # 构建生产包
npm run example:car:lint         # ESLint 检查
```

## 代码规范

- 组件用函数式 + hooks，不用 class 组件
- 文件命名：组件 PascalCase.jsx，工具函数 camelCase.js
- 中文 UI 文案直接写在组件中，不做 i18n
- 不写注释，除非逻辑非常不直观
- commit 信息格式：`类型: 中文描述`，类型用 feat/fix/update/refactor

## 项目结构

前端代码在 `react-app/src/` 下，组件在 `components/` 目录。
后端系统工具在 `server/tools/` 下，Built-in Skill schema 在 `server/domains/` 下，领域 executor 在 `server/domain-executors/` 下，Custom Skills 在 `server/custom-skills/` 下，Voice Realtime provider 在 `server/voice/providers/` 下。
3D 模型文件在 `react-app/public/`。
根目录 `index.html` 是旧版原型备份，不要修改。

## 注意事项

- GLB 模型加载后 Three.js 会去掉节点名中的点号（如 `glass.0_0` → `glass0_0`）
- 车辆状态（车窗/大灯）通过 App.jsx 的 `carState` 统一管理
- 设置面板选中态用灰色背景，不用绿色边框
