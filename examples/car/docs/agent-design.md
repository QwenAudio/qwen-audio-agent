# Qwen Audio Agent Car 架构设计

## 概述

Qwen Audio Agent Car 的 Agent 是智能座舱助手的大脑。它负责理解用户意图、维护长期记忆和多轮上下文、调度 Built-in Skills，并把工具执行结果转换成 UI actions 和自然语言回复。

当前 Agent 同时服务两条入口：

- 文本入口：`POST /api/chat/stream`，用于调试面板输入。
- 语音入口：`WS /api/voice/realtime`，由 Realtime Provider 识别语音后通过 `route_to_car_agent` 路由到同一套 Agent。

## 能力分层

| 层级 | 定义 | 代码位置 |
|---|---|---|
| Tools | 跨领域的系统基础工具 | `server/tools/`、`server/amap-mcp.mjs` |
| Built-in Skills | 系统内置领域能力，对 LLM 暴露为 function calling | `server/domains/`、`server/domain-executors/`、`server/skills/builtin/index.mjs` |
| Custom Skills | 用户通过对话创建的 Markdown 流程编排 | `server/custom-skills/{clientId}/{skillName}/SKILL.md` |

原则：LLM 只直接看见 Built-in Skills 和基础系统工具；各领域的最终函数定义在 `server/domains/*.json`，实现和业务约束放在对应的 domain executor 中。

## 总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                          React 前端                                │
│  ChatPanel / VoiceDock / VehiclePanel / MapPanel / MusicPanel      │
│  FlashBuyPanel / Settings / Dock / TopBar                          │
│  统一接收 actions[]、progress、tool_calls、assistant 流式文本        │
└───────────────┬───────────────────────────────┬────────────────────┘
                │ /api/chat/stream               │ /api/voice/realtime
                ▼                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Node Agent Server                          │
│                                                                    │
│  agent.mjs                                                         │
│  - 构造 system prompt：当前时间、人设、记忆、Skill 目录、历史上下文   │
│  - 调用 DashScope OpenAI-compatible Chat Completions                │
│  - 执行 function calls，收集 actions/debug                          │
│  - 支持 chat() 和 chatStream()                                      │
│                                                                    │
│  voice/realtime.mjs                                                │
│  - 浏览器 WebSocket 网关                                            │
│  - 连接 Realtime Provider                                           │
│  - 处理 route_to_car_agent                                          │
│  - 转发语音状态、音频、progress、tool_calls、actions                 │
│                                                                    │
│  tools/index.mjs + domains/*.json + domain-executors/*.mjs          │
│  - 注册 LLM 可见能力                                                │
│  - 将 domain function 绑定到对应 executor                           │
└────────────────────────────────────────────────────────────────────┘
```

## Agent 编排层

`server/agent.mjs` 提供两个主要入口：

- `chat()`：非流式调用，返回最终 `{ content, actions, debug }`。
- `chatStream()`：流式调用，边生成边通过 `onEvent` 发出 `thinking`、`progress`、`tool_call`、`map_action`、`content_delta` 和 `done`。

语音链路当前使用 `chatStream()`，因此语音模式下调试面板也可以流式显示思考、工具调用和最终回复。

伪代码：

```text
chatStream(userMessage, sessionId, vehicleState, soul, strategy, thinking, clientId):
  history = loadHistory(sessionId)
  messages = [
    systemPrompt(currentTime, soul, memory, builtinSkills, customSkills),
    ...trimmedHistory,
    userMessage
  ]

  requiredSkill = inferRequiredSkill(userMessage)
  toolChoice = requiredSkill ? force(requiredSkill) : auto

  repeat until done or max rounds:
    response = LLM(messages, tools, toolChoice, enable_thinking)

    stream reasoning_content as thinking
    stream text delta as content_delta

    if tool calls:
      for each tool call:
        execute tool with context callbacks
        emit progress / map_action / tool_call
        collect actions
        append tool result to messages
      continue

    save history
    emit done(content, actions, debug)
```

## System Prompt 组成

Agent prompt 由以下部分组成：

- 当前时间：来自 `server/time-context.mjs`，时区固定为 `Asia/Shanghai`。
- 灵魂设定：来自 `server/souls.mjs`。
- 长期记忆：来自 `server/memory.mjs`。
- Built-in Skill 目录：来自 `server/domains/*.json`，由 `server/skills/builtin/index.mjs` 加载生成。
- Custom Skill 目录：来自 `server/custom-skills/`。
- 路由规则：明确要求车控、导航、音乐、闪购、天气、联网等场景必须调用对应 Skill。
- 当前车辆状态与路线策略。

当前时间 prompt 会要求模型以服务端当前时间理解“今天、明天、昨天、现在、最近、本周、本月”等相对时间。如果问题依赖实时外部事实，仍应调用对应工具。

## 可见工具注册

`server/tools/index.mjs` 会扫描 `server/tools/*.mjs` 中的系统工具，随后注册 `server/skills/builtin/index.mjs` 中加载出的 Built-in Skills。Built-in Skills 的 schema 来自 `server/domains/*.json`，执行逻辑来自 `server/domain-executors/*.mjs`。当前 LLM 可见能力包括：

| function name | 类型 |
|---|---|
| `vehicle_*` | Built-in Skill |
| `navigation_*` | Built-in Skill |
| `music_*` | Built-in Skill |
| `flashbuy` | Built-in Skill |
| `weather` | Built-in Skill |
| `web_search` | Built-in Skill |
| `memory_read` / `memory_write` / `memory_delete` | 系统工具 |
| `skill_create` / `skill_run` | 系统工具 |
| `get_time` / `get_location` | 系统工具 |
| `notify_user` | 系统工具 |
| `timer_set` / `timer_cancel` | 系统工具 |
| `context_compact` | 系统工具 |

## Skill 路由

为了避免非 thinking 模式下模型直接回复而不调用工具，`server/agent.mjs` 会读取 domain JSON 中的 `routeRules` 和 `examples`，在系统 prompt 中强化明确意图到 function 的映射：

- 车控/车辆状态 → 对应 `vehicle_*` function
- 导航/路线/目的地 → 对应 `navigation_*` function
- 音乐播放/搜索 → 对应 `music_*` function
- 外卖/奶茶/淘宝闪购/下单 → `flashbuy`
- 天气/气温/带伞/穿衣 → `weather`
- 最新/实时/网上查/新闻/政策/价格/赛事/限行 → `web_search`

这条规则对文本和语音链路都生效。自定义 Skill 命中时仍会通过 `tool_choice` 强制首轮调用 `skill_run`。

## Progress 与分阶段反馈

Built-in Skills 可以通过 `context.onProgress()` 发阶段事件：

```js
context.onProgress({
  domain: 'navigation',
  stage: 'planning_route',
  message: '正在规划路线',
  speakPolicy: 'always',
})
```

字段语义：

- `domain`：能力域，如 `navigation`、`flashbuy`、`weather`、`web_search`。
- `stage`：阶段 id，用于调试面板和 VoiceDock 动画。
- `message`：用户可见中文文案。
- `speakPolicy`：`always`、`if_slow` 或 `silent`。

文本链路会把 progress 展示在调试面板。语音链路还会根据 `speakPolicy` 调用 Realtime Provider 的 `speakProgress()` 播报短进度。

## Debug 数据

`debug` 结构用于 ChatPanel：

```json
{
  "thinking": "...",
  "tool_calls": [
    {
      "name": "navigation_start",
      "arguments": { "destination": "西湖" },
      "result": "已规划路线...",
      "duration_ms": 296
    }
  ],
  "progress": [],
  "rounds": 2,
  "usage": { "total_tokens": 8295 },
  "duration_ms": 2813
}
```

文本模式中这些事件来自 SSE；语音模式中来自 WebSocket 事件：

- `agent_thinking`
- `agent_progress`
- `agent_tool_call`
- `agent_debug`
- `transcript_delta`
- `transcript`

前端把两条链路归一成同一种 assistant message 结构，避免调试面板出现两套 UI。

## 语音入口与 Agent 的关系

Realtime 入口模型只负责音频交互和轻量路由，不重新实现车载 Agent。

当用户请求涉及车控、导航、音乐、天气、联网查询、闪购、记忆、提醒、自定义技能或时间相关任务时，语音模型必须调用：

```text
route_to_car_agent
```

后端收到 function call 后：

1. 进入 `thinking` 状态。
2. 调用 `chatStream()`。
3. 将 progress、tool_calls、map_action、actions 发给前端。
4. 将最终 content 通过 provider 受控播报。
5. 刷新 Realtime session 的记忆和最近上下文。

## 超时策略

语音链路有独立超时，防止 VoiceDock 长时间停在 thinking：

- VoiceDock thinking 总超时：30s。
- 语音 Agent 总超时：35s。
- 语音 Agent LLM 单次超时：18s。
- 语音 Agent 工具调用超时：15s。

超时后网关会清理会话状态、关闭 provider、向前端发送错误并回到 `idle`。

## 持久化

- 长期记忆：`server/data/clients/{clientId}/memory.json`
- 会话历史：`server/data/sessions/{sessionId}/history.json`
- Custom Skills：`server/custom-skills/{clientId}/{skillName}/SKILL.md`

语音直接闲聊会写入统一 history；路由到 Agent 的任务由 Agent 写入 history，避免一轮对话重复保存。
