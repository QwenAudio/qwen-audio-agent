# Qwen Audio Agent 智能座舱示例

[English](README.md) | 中文

这是一个基于 qwen-audio-agent 的可运行智能座舱 Agent 示例。用户可以通过自然语音
控制车辆、规划导航、播放音乐、查询天气、使用闪购和自定义技能，座舱界面会同步展示
车辆与任务状态。它展示了如何使用框架组合前台实时对话、工具调用和可替换的后台 Agent。

## 座舱演示

通过自然语音发起车控和导航任务，展示前台实时对话、后台 Agent 执行与座舱 UI 状态联动。

> 建议开启声音观看。

https://github.com/user-attachments/assets/0136b6ec-2ff8-49ba-8f07-55e7006d2e7d

## 架构

![智能座舱框架架构图](docs/framework-architecture.svg)

qwen-audio-agent 的基础边界是“前台对话 + 后台执行”。座舱客户端与 Gateway 组成前台，
座舱 Agent 负责后台任务，Service 提供场景状态、业务规则和工具执行环境。

完整的边界与数据流见[架构文档](docs/architecture.md)。

## 评测结果

评测使用同一套工具、Prompt、确定性状态和评分器，对比 Text 与 Realtime 模型的座舱
工具调用能力。

### 短用例集

86 个标准用例，覆盖车控、音乐、导航和天气。

| 领域 | 用例数 | 预期调用数 | Text 通过率 | Text 实际调用 | Realtime 通过率 | Realtime 实际调用 |
|---|---:|---:|---:|---:|---:|---:|
| Vehicle | 24 | 23 | 100.00% | 23 | 100.00% | 23 |
| Music | 18 | 17 | 100.00% | 17 | 100.00% | 17 |
| Navigation | 36 | 44 | 100.00% | 44 | 97.22% | 44 |
| Weather | 8 | 8 | 100.00% | 8 | 100.00% | 8 |
| Overall | 86 | 92 | 100.00% | 92 | 98.84% | 92 |

### 长上下文集

10 段混合领域对话，共 500 轮、250 次预期工具调用和 250 个无工具闲聊/背景轮次。
长上下文评测关注工具调用、状态和无工具判断，不使用端到端任务通过率。

| 模型 | 调用 预期/实际 | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Checkpoints | Silent turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Text `qwen3.8-flash` | 250 / 252 | 88.80% | 100.00% | 91.20% | 100.00% | 0 / 2 | 100.00% | 100.00% | 90.00% |
| Realtime `qwen-audio-3.0-realtime-plus` | 250 / 246 | 71.20% | 98.40% | 76.00% | 98.40% | 4 / 0 | 100.00% | 80.00% | 100.00% |

数据集、运行命令、alignment 指标、超时重试和评分规则见 [Benchmark 说明](bench/README.md)。

## 核心特点

- **实时语音对话：**支持连续交流、自然打断、多轮上下文、音色和人设切换。
- **标准工具调用：**车控、导航、音乐、天气、闪购和自定义技能统一定义为 MCP 工具。
- **前后台分工：**低延迟操作以及自定义技能创建、加载由前台 Realtime 处理；闪购和多来源新闻研究交给后台 Agent。
- **标准后台接入：**示例 Agent 通过 A2A 1.0 连接 Gateway，可替换为客户自己的 A2A、ACP 或定制后台。
- **场景状态联动：**座舱 UI 通过场景 HTTP/SSE 通道展示车辆、路线、音乐和订单状态。
- **组件可替换：**客户可以独立替换座舱客户端、后台 Agent 或场景 Service，无需修改框架核心。

## 交互路径

- 同一模型响应中的多个前台工具完成后，统一作一次语音收口。前台 MCP 调用默认超时为
  10 秒，失败会如实返回，不会当成执行成功。
- 屏幕修改路线偏好后，通过场景事件静默写入对话上下文；助手能解释当前偏好，不把
  “高速优先”等同于车辆已经驶上高速。
- 用户可通过语音保存温度提醒规则，再点击 UI 的温度 `−` / `+` 改变空调设定温度。
  只有从条件外进入条件内才提醒一次，停留在条件内不会重复提醒。
- 记忆沿用框架标准 Markdown 记忆工具及 Prompt 策略，不增加座舱专用记忆协议。
- 新闻汇总报告异步执行，期间前台继续聊天。后台真实搜索并读取来源，以 A2A 文本
  artifact 返回完整报告并给出简短口播摘要，保留日期与核验限制；没有证据时不编造“最新新闻”。

## 快速开始

在仓库根目录执行：

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
```

至少填写：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
```

高德地图和路线服务可按需填写 `VITE_AMAP_KEY`、`VITE_AMAP_SECRET` 与 `AMAP_MCP_KEY`。
然后安装依赖并启动示例：

```bash
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

浏览器打开 `http://localhost:5173`。按 `Ctrl+C` 可一起关闭全部示例进程。

六段语音、环境感知、技能和记忆演示的口令与验收标准，见[录制清单](docs/demo-recording.zh.md)。

## 工具调用

座舱 Service 在 6 个场景领域共提供 38 个工具，工具定义、执行器和前后台分流均保持独立。

| 领域 | 数量 | 能力示例 |
|---|---:|---|
| `vehicle` | 11 | 车辆位置与车况、空调、车窗、天窗、车灯、充电等。 |
| `navigation` | 12 | 地点搜索、路线规划、多途经点、常用地点、路线偏好和停止导航。 |
| `music` | 10 | 搜索与播放、上下曲、音量、媒体源和收藏。 |
| `weather` | 1 | 城市天气查询。 |
| `flashbuy` | 1 | 闪购商品搜索与下单演示。 |
| `custom-skills` | 3 | 列出、创建/更新、加载工作流或结构化温度提醒规则。 |
| **合计** | **38** | 覆盖前台低延迟操作与后台组合任务。 |

Realtime 模型看到的是 Gateway 组装后的 function 工具面：除了上表中的前台
MCP 工具，还包含 Gateway 内置工具和按能力动态启用的工具。

| Function 工具来源 | 数量 | 工具 |
|---|---:|---|
| Gateway 内置默认工具 | 7 | `spawn_thinking`、`schedule_reminder`、`cancel_agent_task`、`get_agent_task_status`、`get_current_time`、`memory`、`notes` |
| Gateway 内置条件工具 | 最多 +7 | `knowledge`、`recall`、`respond_permission`、`respond_agent_input`、`web_search`、`fetch_url`、`enter_sleep`；仅在对应知识库、会话摘要、检索、待确认权限、待补充输入或客户端休眠动作可用时暴露 |
| 座舱前台 MCP 工具 | 37 | `vehicle`、`navigation`、`music`、`weather` 及 3 个 `custom-skills` 工具，模型中以 `mcp__cockpit__*` 名称出现 |
| **默认 Realtime 基础合计** | **44** | 7 个 Gateway 内置工具 + 37 个座舱前台 MCP 工具，不含按能力加入的条件工具 |

默认情况下，`vehicle`、`navigation`、`music`、`weather` 和 `custom-skills` 走前台
Realtime 路径，Service 只有 `flashbuy` 暴露给后台。前台加载工作流后直接执行前台步骤，
仅把确实需要后台能力的步骤交给后台。通过
[`surface-routing.json`](service/tools/surface-routing.json) 即可调整场景分流；扩展方式见
[工具目录说明](service/tools/README.md)。

后台 Agent 另外通过 `qwen-audio-agent/web-retrieval` 组合框架的 `web_search` 与
`fetch_url`：默认是 1 个 Service 工具 + 2 个网页检索工具。后两者不计入 38 个场景工具。
搜索沿用前台相同的 Provider 配置；默认免 Key 搜索是实验性兜底，正式录制前应验证供应商
可访问性，详见[联网搜索配置](../../docs/guides/web-search.zh.md)。

## 替换和扩展

| 需求 | 修改位置 |
|---|---|
| 替换座舱 UI 或音频 I/O | [`client/`](client/) |
| 替换后台 Agent | 修改 `COCKPIT_AGENT_CARD_URL`，或替换 [`agent/`](agent/) |
| 增加场景工具、状态或外部服务 | [`service/`](service/) 与 [`service/tools/`](service/tools/) |
| 调整前台人设或后台任务语义 | [`gateway/`](gateway/) |
| 调整前后台工具分流 | [`surface-routing.json`](service/tools/surface-routing.json) |

更完整的迁移方法见[组件替换指南](docs/replacing-components.md)。

## 作者与致谢

- [Zhang Binbin](https://github.com/robin1001)：负责座舱领域能力的设计与扩展，包括导航、
  车控、音乐工具体系、前后台工具分流与评测用例。
- [Li Xu](https://github.com/x-lixu)：负责基于 qwen-audio-agent 的场景架构与整体实现，
  包括客户端、Gateway、后台 Agent 的边界，实时语音链路以及 A2A/MCP 接入。
- [Peng Zhendong](https://github.com/pengzhendong)：提供原始座舱 UI 与视觉资源，包括整体界面设计、
  交互形态和相关视觉素材。
