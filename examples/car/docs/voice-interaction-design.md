# 端到端语音交互设计

## 目标

语音入口要做到三件事：

1. 用户可以用浏览器麦克风直接和车载助手对话。
2. 闲聊由 Realtime 语音模型直接语音回复。
3. 车控、导航、音乐、闪购、天气、联网、记忆、提醒和自定义技能统一路由到现有 Agent 执行。

语音链路不重新实现一套座舱工具逻辑。所有真实任务仍走 `agent.mjs` 和 Built-in Skills。

## 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         React 前端                            │
│  useVoiceSession                                              │
│  - 麦克风采集 16 kHz mono PCM                                  │
│  - WebSocket 连接 /api/voice/realtime                         │
│  - 播放 24 kHz PCM 音频队列                                    │
│  - 输出 muted / voiceState / inputLevel / outputLevel          │
│                                                              │
│  VoiceDock + VoiceWave                                        │
│  - 展示 Mute、idle、listening、thinking、speaking              │
│  - 展示阶段进度文案和任务态动画                                │
│                                                              │
│  ChatPanel                                                    │
│  - 统一展示文本和语音 assistant 消息                           │
│  - 展示 thinking、progress、tool_calls、最终回复                │
└───────────────┬──────────────────────────────▲───────────────┘
                │ WS /api/voice/realtime        │ audio/actions/debug
                ▼                              │
┌──────────────────────────────────────────────────────────────┐
│                    Voice Gateway (Node.js)                    │
│  server/voice/realtime.mjs                                    │
│  - 连接当前 Realtime Provider                                  │
│  - 转发 input_audio_buffer.append                              │
│  - 监听 VAD、转写、function call、音频回复事件                  │
│  - 处理 route_to_car_agent                                     │
│  - 调用 chatStream()                                           │
│  - 转发 progress、tool_calls、actions、map_action               │
│  - 用 provider.speakProgress() 播报阶段和最终结果               │
└───────────────┬──────────────────────────────▲───────────────┘
                │ chatStream()                  │ function output
                ▼                              │
┌──────────────────────────────────────────────────────────────┐
│                    Existing Agent Server                      │
│  Built-in Skills: vehicle_* / navigation_* / music_*          │
│                   flashbuy / weather / web_search             │
│  System Tools: memory / skill / time / location / notify      │
└──────────────────────────────────────────────────────────────┘
```

## Realtime Provider

语音网关面向统一的 Realtime provider 接口。当前 provider：

- id：`qwen-audio-realtime`
- 文件：`server/voice/providers/dashscope-realtime.mjs`
- 默认模型：`qwen-audio-3.0-realtime-plus`
- 默认音色：`longanqian`
- 配置入口：`.env.local` 中的 `QWEN_AUDIO_REALTIME_MODEL`、`QWEN_AUDIO_REALTIME_VOICE`、`QWEN_AUDIO_REALTIME_BASE_URL`

前端不提供模型选择。Audio 和 Omni 系列模型都通过同一个 DashScope Realtime 协议接入，
服务端根据 `QWEN_AUDIO_REALTIME_MODEL` 对应的 model profile 生成 session 参数。

Provider 必须实现网关依赖的接口：

- `connect(config)`
- `updateSession(config)`
- `appendAudio(audio)`
- `sendFunctionOutput(callId, output, options)`
- `speakProgress(message)`
- `close()`

后续接入其他 Realtime 协议时，应新增 provider 文件，并保持前端 WebSocket 协议不变。

## Realtime Instructions

Realtime 入口模型会注入：

- 当前灵魂设定。
- Asia/Shanghai 当前时间 prompt。
- 完整用户记忆。
- 最近 5 轮对话上下文。

它只拥有一个工具：

```text
route_to_car_agent
```

必须路由到 Agent 的场景：

- 车窗、天窗、大灯、空调、车辆状态。
- 导航、路线、目的地、途经点、停止导航。
- 音乐播放、暂停、切歌、搜索歌曲。
- 淘宝闪购、外卖、奶茶、咖啡、点餐、下单。
- 天气、气温、带伞、穿衣建议。
- 联网、最新、实时、新闻、政策、价格、限行等强时效查询。
- 用户记忆、偏好、提醒、自定义技能。
- 时间相关任务，例如“提醒我十分钟后”“今天几号”“明天早上”。
- 多步骤座舱任务，例如“下班回家”“送老婆到公司”。

调用工具前，语音模型要先说一句不承诺结果的短 filler，例如“我看一下”“稍等哦”“我查查”。这句话用于降低等待感，UI 仍保持 thinking。

## WebSocket 协议

入口：

```text
WS /api/voice/realtime?clientId=...
```

### 前端发送

```json
{ "type": "unmute" }
{ "type": "mute" }
```

```json
{
  "type": "config",
  "soul": "聊愈师",
  "routeStrategy": 0,
  "thinking": false
}
```

```json
{
  "type": "audio",
  "audio": "<base64 pcm16 16k mono>"
}
```

### 后端发送

语音状态：

```json
{ "type": "voice_state", "state": "idle" }
{ "type": "voice_state", "state": "listening" }
{ "type": "voice_state", "state": "thinking" }
{ "type": "voice_state", "state": "speaking" }
```

转写与助手文本：

```json
{ "type": "transcript", "role": "user", "content": "导航去西湖" }
{ "type": "transcript_delta", "role": "assistant", "content": "已为" }
{ "type": "transcript", "role": "assistant", "content": "已为你规划到西湖的路线..." }
```

Agent 调试：

```json
{ "type": "agent_thinking", "content": "..." }
{ "type": "agent_progress", "progress": { "domain": "navigation", "stage": "planning_route", "message": "正在规划路线" } }
{ "type": "agent_tool_call", "toolCall": { "name": "navigation", "arguments": {}, "result": "...", "duration_ms": 124 } }
{ "type": "agent_debug", "debug": { "tool_calls": [], "usage": {}, "duration_ms": 2813 } }
```

音频和 UI action：

```json
{ "type": "audio", "audio": "<base64 pcm16 24k mono>", "sampleRate": 24000 }
{ "type": "audio_done" }
{ "type": "agent_actions", "actions": [] }
{ "type": "agent_map_action", "mapAction": {} }
{ "type": "error", "message": "..." }
```

## 状态机

前端维护：

- `muted`：是否静音。默认 `true`。
- `voiceState`：非静音时的运行状态。

| 状态 | 触发 | UI 表现 |
|---|---|---|
| `muted` | 用户静音 | 保留毛玻璃面板和低能量环境流动 |
| `idle` | 非静音但无输入输出 | 低能量环境流动 |
| `listening` | `input_audio_buffer.speech_started` | 用户色从左向右流动，强度跟输入音量联动 |
| `thinking` | 用户说话结束、function call、等待 Agent | 用户色到系统色之间往复扫动 |
| `speaking` | 收到 `response.audio.delta` 或本地音频播放中 | 系统色从右向左流动，强度跟输出音量联动 |
| `error` | 后端或 provider 错误 | 短暂错误态后回到 idle |

注意：`response.done` 不等于浏览器音频播放完成。前端会等本地播放队列结束后再从 `speaking` 回到 `idle`，避免动画提前停止。

## VoiceDock 设计

最新布局参考 Tesla / Grok 的 Dock 化语音交互，但使用本项目的浅色毛玻璃风格，不使用突兀黑色底。

结构：

- 左上：主提示文案“说吧，想做什么？”，有进度时替换为“正在查找目的地”等阶段文案。
- 左下：麦克风按钮。
- 左下中部：灵魂选择，只显示当前灵魂，不显示音色。
- 右上：预留 Qwen Audio Agent Car 标识位置。
- 右下：设置按钮，保持原有按钮风格。
- 中下：整块光场动效，由 `VoiceWave` canvas 绘制。

灵魂选择：

- `聊愈师`
- `行动派`
- `疯批`

选择结果保存在前端本地，下次进入仍使用上次选择。

## 动画语义

当前不使用传统语音波形柱。原因是座舱 Dock 更像系统层控件，柱状波形容易显得像录音软件，和地图/车控 UI 不够统一。

`VoiceWave` 使用 Canvas 绘制光场、扫动段和底部 rail：

- 基础底色：低饱和青绿色，与整体车机 UI 保持一致。
- 用户说话：绿色系，左向右，表示“输入进入系统”。
- 系统思考：左侧偏用户绿，右侧偏系统金，中间过渡蓝，左右往复，表示“系统在处理”。
- 系统说话：金色系，右向左，表示“系统输出返回用户”。
- 任务阶段：导航、闪购等 progress stage 会覆盖默认状态样式，让动画与业务过程一致。

典型任务阶段：

- 导航：
  - `searching_destination`
  - `destination_locked`
  - `planning_route`
  - `route_ready`
  - `navigation_started`
- 闪购：
  - `flashbuy_searching`
  - `flashbuy_adding`
  - `flashbuy_previewing`
  - `flashbuy_ordering`
  - `flashbuy_order_completed`

## 分阶段播报

Built-in Skills 通过 `context.onProgress()` 控制中间反馈：

```js
context.onProgress({
  domain: 'navigation',
  stage: 'searching_destination',
  message: '正在查找目的地',
  speakPolicy: 'always',
})
```

语音网关处理策略：

- `always`：立即调用 `provider.speakProgress(message)`。
- `if_slow`：阶段持续超过 250ms 才播报。
- `silent`：只更新 UI 和调试面板，不播报。

进度播报和最终回复都使用同一个 Realtime Provider 的合成能力，避免两个声音割裂。开始导航这类会被最终 Agent 回复覆盖的信息通常设置为 `silent`，避免重复播报。

## 调试面板统一

语音模式不会单独维护一套调试 UI。`useVoiceSession` 把 WebSocket 事件归一为和文本模式一致的 assistant message：

- `agent_thinking` → `msg.thinking`
- `agent_progress` → `msg.debug.progress`
- `agent_tool_call` → `msg.debug.tool_calls`
- `agent_debug` → `msg.debug`
- `transcript_delta` → 流式追加 `msg.content`

因此车控、导航、音乐、闪购、天气、联网查询在语音模式和文本模式下会展示统一的思考、进度、工具调用和最终回复。

## 错误与超时

语音网关会在以下情况主动回到 idle：

- 用户 mute。
- WebSocket 关闭。
- provider 报错。
- thinking 超过 30s。
- Agent 总耗时超过 35s。
- LLM 单次调用超过 18s。
- 工具调用超过 15s。

超时会清理 pending audio、progress speech 队列、provider response 状态和 function call 标记，避免 VoiceDock 一直停在 thinking。

## 当前未做

- 唤醒词。
- 多麦克风设备选择。
- 真正双工打断。
- 回声消除深度优化。
- 长时间语音会话断线恢复。
- 局域网 HTTPS 自动证书配置。
