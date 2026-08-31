# Qwen Audio Agent Car Future Goals

## 目标状态

Qwen Audio Agent Car 的长期目标是把车控、导航、音乐、闪购、天气、联网查询和后续新增领域都收敛到一套可配置、可评测、可扩展的工具体系中。

核心目标：

- 所有领域 function 的最终原子定义统一来自 `server/domains/*.json`。
- 每个大类领域共享一个 domain JSON 文件，避免每个 function 一个文件，方便后续扩展。
- 每个 function 可以通过配置选择运行在 Realtime 侧（前台）或文本 LLM Agent 侧（后台）。
- 前后台放置策略不靠主观判断固定，而是通过测试集和 benchmark 做量化选择。
- 建立一套 harness 统一管理前后台路由、工具执行、记忆注入、事件追踪和评测。
- 输出每个领域的工具数量，并持续跟踪 Realtime 与文本模型在工具调用上的准确率对比。

## 分层原则

`server/domains/*.json` 是领域 function 的唯一 schema 来源。它描述函数名称、参数、领域路由规则、示例、可见性和执行器绑定。

`server/domain-executors/*.mjs` 承载每个领域的业务约束和执行逻辑。它负责参数校验、状态读取、外部服务调用、UI actions 生成和领域内安全限制。

`server/tools/*.mjs` 只保留跨领域系统基础能力，例如时间、位置、记忆、提醒、自定义技能和上下文压缩。车控、导航、音乐、闪购、天气和联网查询不再在 `tools/` 下重复定义领域 function。

## 前后台配置

未来每个领域 function 应支持类似以下维度的配置：

- `realtime`: 是否允许暴露给 Realtime 侧直接调用。
- `text`: 是否允许暴露给文本 LLM Agent 侧调用。
- `benchmarkSet`: 该 function 所属评测集。
- `riskLevel`: 执行风险等级，用于限制是否允许前台直接执行。
- `requiresConfirmation`: 是否需要用户确认后再执行。

配置策略可以先从 `domains/*.json` 的 `exposure` 字段扩展，也可以在后续引入独立的 placement 配置文件。无论采用哪种形式，domain JSON 中的 function 定义仍然是最终原子定义。

## Harness 目标

Harness 负责把领域工具、前后台路由、记忆和评测串起来。

它需要支持：

- 加载所有 domain function，统计每个领域的工具数量。
- 根据配置生成 Realtime 侧和文本 LLM 侧的工具暴露列表。
- 执行统一测试集，覆盖单轮、多轮、长历史和含记忆场景。
- 记录模型是否真实调用工具、调用了哪个工具、参数是否正确、是否产生正确 UI action。
- 对比 Realtime 侧与文本 LLM 侧的工具调用准确率、参数准确率、动作成功率和平均耗时。
- 输出可复现的评测结果，作为 function 放置策略的依据。

## 评测指标

至少需要保留以下指标：

| 指标 | 含义 |
|---|---|
| domainToolCount | 每个领域注册的 function 数量 |
| functionCallAccuracy | 是否调用了期望 function |
| argumentAccuracy | function 参数是否符合测试集期望 |
| actionSuccessRate | 是否产生期望 UI action 或领域结果 |
| noHallucinatedCompletionRate | 是否避免未调用工具却声称已完成 |
| averageLatencyMs | 平均端到端耗时 |

这些指标要同时区分 Realtime 侧和文本 LLM Agent 侧，便于比较不同模型、不同 placement 配置和不同 prompt 策略。

## 当前阶段

当前阶段已经完成领域 schema 与 executor 的基础收敛：车控、导航、音乐、闪购、天气和联网查询都以 `server/domains/*.json` 作为 function 定义入口，并由 `server/domain-executors/*.mjs` 执行。

下一阶段应优先补齐 placement 配置和 benchmark harness，让前后台工具放置可以通过测试数据持续迭代。
