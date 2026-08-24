# Tools and Skills Design

## 分层模型

当前 Agent 能力分为三层：

| 层级 | 定义 | 面向对象 | 代码位置 |
|---|---|---|---|
| Tools | 跨领域的系统基础工具 | LLM / Agent | `server/tools/`、`server/amap-mcp.mjs` |
| Built-in Skills | 系统内置领域能力，对 LLM 暴露为 function calling | LLM / Agent | `server/domains/`、`server/domain-executors/`、`server/skills/builtin/index.mjs` |
| Custom Skills | 用户通过对话创建的 Markdown 流程编排 | 用户 / LLM | `server/custom-skills/{clientId}/{skillName}/SKILL.md` |

核心原则：LLM 优先调用 Built-in Skills；各领域的最终原子函数定义在 `server/domains/*.json`；对应实现和业务约束放在 `server/domain-executors/*.mjs`；`server/tools/` 只保留跨领域系统工具；Custom Skills 编排 Built-in Skills 和少量基础系统工具。

## 当前 Built-in Skills

| Skill | function name | 实现位置 |
|---|---|---|
| 车控 | `vehicle_state_query`, `vehicle_window_control`, `vehicle_sunroof_control`, `vehicle_headlights_control`, `vehicle_climate_control` | `server/domain-executors/vehicle.mjs` |
| 导航 | `navigation_start`, `navigation_route_query`, `navigation_stop` | `server/domain-executors/navigation.mjs` |
| 音乐 | `music_play`, `music_pause`, `music_next`, `music_previous`, `music_search` | `server/domain-executors/music.mjs` |
| 淘宝闪购 | `flashbuy` | `server/domain-executors/flashbuy.mjs` |
| 天气 | `weather` | `server/domain-executors/weather.mjs` |
| 联网查询 | `web_search` | `server/domain-executors/web-search.mjs` |

`server/tools/index.mjs` 是可见能力注册出口。它会扫描系统工具，再追加 `server/skills/builtin/index.mjs` 中注册出的 Built-in Skills。

Built-in Skills 的 schema 由 `server/domains/*.json` 提供，每个大类一个 JSON 文件，这些 function 就是领域最终原子定义；执行逻辑由 `server/domain-executors/*.mjs` 绑定，每个大类一个 executor 文件。

## 当前 LLM 可见能力

| function name | 类型 | 说明 |
|---|---|---|
| `vehicle_state_query` | Built-in Skill | 查询车窗、天窗、大灯、空调等车辆状态 |
| `vehicle_window_control` | Built-in Skill | 打开或关闭单个/全部车窗 |
| `vehicle_sunroof_control` | Built-in Skill | 打开或关闭天窗 |
| `vehicle_headlights_control` | Built-in Skill | 打开或关闭大灯 |
| `vehicle_climate_control` | Built-in Skill | 打开/关闭空调，设置温度、模式和风量 |
| `navigation_start` | Built-in Skill | 地点搜索、路线规划并开始导航 |
| `navigation_route_query` | Built-in Skill | 地点搜索和路线规划，不开始导航 |
| `navigation_stop` | Built-in Skill | 停止当前导航并清空路线 |
| `music_play` | Built-in Skill | 播放或继续播放音乐 |
| `music_pause` | Built-in Skill | 暂停音乐 |
| `music_next` / `music_previous` | Built-in Skill | 切换下一首/上一首 |
| `music_search` | Built-in Skill | 搜索歌曲、歌手或专辑 |
| `flashbuy` | Built-in Skill | 淘宝闪购外卖/奶茶搜索、加购、试算订单、确认下单 |
| `weather` | Built-in Skill | 查询当前城市或指定城市天气 |
| `web_search` | Built-in Skill | 查询最新、实时、新闻、政策、价格、活动等联网信息 |
| `memory_read` / `memory_write` / `memory_delete` | 系统工具 | 长期记忆管理 |
| `skill_create` / `skill_run` | 系统工具 | Custom Skill 创建和加载 |
| `get_time` / `get_location` | 系统工具 | 当前时间与车辆位置 |
| `notify_user` | 系统工具 | 主动通知 |
| `timer_set` / `timer_cancel` | 系统工具 | 提醒定时器 |
| `context_compact` | 系统工具 | 对话历史压缩 |

## Skill 路由规则

`server/agent.mjs` 会读取 `server/domains/*.json` 中的 `routeRules` 和 `examples`，在系统 prompt 中强化以下路由：

- 车控、车况、空调、车窗、天窗、大灯 → 对应 `vehicle_*` function
- 导航、路线、目的地、途经点、停止导航 → 对应 `navigation_*` function
- 播放、暂停、切歌、点歌、歌单 → 对应 `music_*` function
- 外卖、奶茶、咖啡、点餐、淘宝闪购、下单 → `flashbuy`
- 天气、气温、下雨、带伞、穿衣、冷不冷、热不热、风力 → `weather`
- 最新、实时、新闻、政策、公告、活动、价格、股价、汇率、油价、金价、赛事、限行、网上查 → `web_search`

如果用户请求命中明确领域，Agent 会通过明确的 function schema 和提示词降低模型直接回复、不调用工具的概率。

## Built-in Skill 设计

### 车控 functions

车控能力按意图拆分为状态查询、车窗、天窗、大灯和空调。每个控制类 function 在 executor 中完成状态读取、参数校验和 UI actions 生成。

典型参数：

```json
{ "function": "vehicle_window_control", "arguments": { "action": "open", "window": "windows" } }
{ "function": "vehicle_climate_control", "arguments": { "action": "set_temp", "temperature": 23 } }
{ "function": "vehicle_state_query", "arguments": { "part": "all" } }
```

前端 action 示例：

```json
{ "type": "car_control", "part": "windowFL", "state": 1 }
```

### 导航 functions

导航能力拆分为开始导航、路线查询和停止导航。它会向前端发阶段进度和地图 actions：

- `searching_destination`：正在查找目的地。
- `destination_locked`：已锁定目的地。
- `planning_route`：正在规划路线。
- `route_ready`：路线规划完成。
- `navigation_started`：开始导航。

前端 action 示例：

```json
{
  "type": "navigation",
  "action": "start",
  "destination": "西湖",
  "route": {
    "distanceText": "23.6km",
    "durationText": "52分钟"
  }
}
```

### 音乐 functions

音乐能力拆分为播放、暂停、上一首、下一首和搜索歌曲。

```json
{ "function": "music_play", "arguments": { "query": "晴天" } }
```

### `flashbuy`

用于淘宝闪购伪实现。当前支持外卖和奶茶两类商品，语音可以驱动搜索、加购、试算和确认下单。

关键约束：

- 下单前必须先预览订单。
- 只有用户明确确认时才能 `confirm_order`。
- Executor 会发 `flashbuy` actions 打开闪购应用、更新商品列表、购物车、订单预览和配送状态。

典型流程：

```text
用户：帮我点一杯热奶茶
flashbuy(search/add_to_cart) → 搜索附近商品 → 加入购物车 → 试算订单
助手：我找到一杯厚芋泥鲜奶，预计 20 分钟送到，总价 24 元，要下单吗？
用户：确认
flashbuy(confirm_order) → 模拟下单
```

### `weather`

用于天气、气温、下雨、穿衣和带伞建议。Executor 通过高德 MCP 查询天气数据。

前端 action 会更新 TopBar 天气状态：

```json
{ "type": "weather", "weather": { "city": "杭州", "dayweather": "多云", "daytemp": "28" } }
```

### `web_search`

用于强时效或需要联网的问题。Executor 调用 DashScope/通义文本生成接口，并开启联网搜索：

- `enable_search: true`
- `forced_search: true`
- `enable_source: true`
- `enable_citation: true`

返回内容包含简洁答案和最多 6 条来源摘要。天气优先用 `weather`，导航优先用 `navigation_*`，车控优先用 `vehicle_*`，闪购优先用 `flashbuy`。

## Custom Skill 编写约定

用户自定义 Skill 应优先编排 Built-in Skills：

```markdown
---
name: 下班回家
description: 一键设置回家路线、播放音乐、调节车内环境
---

1. 调用 navigation_start，目的地为“家”。
2. 调用 music_play，播放用户喜欢的音乐。
3. 调用 vehicle_window_control，关闭所有车窗。
4. 如果用户想顺路买东西，可以调用 flashbuy。
5. 如果需要判断天气或限行，分别调用 weather 或 web_search。
```

只有时间、位置、记忆、通知、定时器等基础能力才直接使用系统工具，例如 `get_time`、`get_location`、`memory_read`、`notify_user`。

## 调试信息

Built-in Skills 可以通过 `context.onProgress()` 上报阶段进度，通过 `context.onSubCall()` 上报外部 provider 调用。文本和语音链路都会把这些信息放进调试面板：

- `progress`：阶段名称、中文文案、领域标签、播报策略。
- `tool_calls`：工具名、参数、结果、耗时。
- `thinking`：模型思考内容，只有开启 thinking 时显示。
- `usage` / `duration_ms`：token 和耗时。
