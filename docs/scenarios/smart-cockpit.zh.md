# 智能座舱

智能座舱是 qwen-audio-agent 的可运行场景示例。用户可以通过自然语音控制车辆、
规划导航、播放音乐、查询天气、使用闪购和自定义技能，座舱界面会同步展示
车辆与任务状态。

## 演示

通过自然语音发起车控和导航任务，展示前台实时对话、后台 Agent 执行与座舱 UI 状态联动。

<video controls preload="metadata" style="width: 100%; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/0136b6ec-2ff8-49ba-8f07-55e7006d2e7d" type="video/mp4">
</video>

## 核心特点

- 支持连续对话、自然打断、多轮上下文、音色和人设切换。
- 使用 MCP 统一扩展车控、导航、音乐、天气、闪购和自定义技能。
- 前台 Realtime 直接执行低延迟操作，后台 Agent 处理闪购和自定义工作流等任务。
- 示例后台 Agent 通过 A2A 1.0 接入，也可替换为 ACP 或定制后台。
- 座舱 UI 使用场景 HTTP/SSE 通道展示车辆、路线、音乐和订单状态。

## 架构

![智能座舱框架架构图](https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/examples/smart-cockpit/docs/framework-architecture.svg)

qwen-audio-agent 的基础边界是“前台对话 + 后台执行”。座舱客户端与 Gateway 组成前台，
座舱 Agent 负责后台任务，Service 提供场景状态、业务规则和工具执行环境。

| 组件 | 示例实现 | 主要接口 |
|---|---|---|
| `client/` | React 座舱 UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| `gateway/` | qwen-audio-agent Gateway + 前台 Realtime Agent | GCP / MCP / BackendPort |
| `agent/` | Qwen3.8-Flash 驱动的后台 Agent | A2A 1.0 / MCP |
| `service/` | 座舱状态、规则、工具和外部服务适配 | HTTP/SSE / MCP |

完整边界和数据流见
[`examples/smart-cockpit/docs/architecture.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/docs/architecture.md)。

## 工具调用

座舱 Service 在 6 个场景领域共提供 38 个 MCP 工具：

| 领域 | 数量 | 主要能力 |
|---|---:|---|
| `vehicle` | 11 | 位置、车况、空调、车窗、车灯和充电等。 |
| `navigation` | 12 | 地点搜索、路线规划、途经点、常用地点和路线偏好等。 |
| `music` | 10 | 搜索、播放、上下曲、音量、媒体源和收藏。 |
| `weather` | 1 | 城市天气查询。 |
| `flashbuy` | 1 | 闪购商品搜索与下单演示。 |
| `custom-skills` | 3 | 列出、创建和加载用户自定义工作流。 |

默认情况下，车控、导航、音乐和天气走前台 Realtime 快路径，闪购与自定义技能
交给后台 Agent。场景方可通过 `service/tools/surface-routing.json` 调整分流。

## 运行示例

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
# 在 .env.local 中填写 DASHSCOPE_API_KEY；地图 Key 可选
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

打开 `http://localhost:5173`。一条命令会同时启动 service、agent、gateway 和 client。

## Benchmark

座舱 Benchmark 使用相同的工具集、Prompt、确定性座舱状态和评分器，对比文本模型与
Realtime 模型的工具选择、参数、执行路径和最终状态。

- 短用例集：86 个用例，覆盖车控、导航、音乐和天气。
- 长上下文集：10 段混合领域对话，共 500 轮，包含 250 次预期工具调用和 250 个无工具轮次。
- Runner：Gold Replay、文本模型、受控 Realtime 模型和完整 Realtime 语音链路。

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs
node examples/smart-cockpit/bench/runner/run-text.mjs
node examples/smart-cockpit/bench/runner/run-realtime.mjs
node examples/smart-cockpit/bench/runner/run-voice.mjs
```

最新结果、数据集和评分方法见
[`examples/smart-cockpit/bench/README.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/bench/README.md)。

## 替换和扩展

| 需求 | 修改位置 |
|---|---|
| 替换座舱 UI 或音频 I/O | `client/` |
| 替换后台 Agent | 修改 `COCKPIT_AGENT_CARD_URL`，或替换 `agent/` |
| 增加场景工具、状态或外部服务 | `service/` 与 `service/tools/` |
| 调整前台人设或后台任务语义 | `gateway/` |

参考[组件替换指南](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/docs/replacing-components.md)
了解完整迁移方法。

## 作者与致谢

- [Zhang Binbin](https://github.com/robin1001)：负责座舱领域能力的设计与扩展，包括导航、车控、
  音乐工具体系、前后台工具分流与评测用例。
- [Li Xu](https://github.com/x-lixu)：负责基于 qwen-audio-agent 的场景架构与整体实现，包括客户端、
  Gateway、后台 Agent 的边界，实时语音链路以及 A2A/MCP 接入。
- [Peng Zhendong](https://github.com/pengzhendong)：提供原始座舱 UI 与视觉资源，包括整体界面设计、
  交互形态和相关视觉素材。
