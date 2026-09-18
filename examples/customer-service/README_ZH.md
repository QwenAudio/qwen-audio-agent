# 客服语音助手示例

[English](README.md) | [中文](README_ZH.md)

一个可运行的零售 / 航空客服 demo：语音前台负责沟通、身份核验与查询，
通过 A2A 将业务操作交给后台 Agent。前后台通过两个 MCP 工具面访问同一份业务状态，
资格、金额、库存和批准由服务层校验，不依赖模型自己算或自己记住流程。

当前适合本地、单通话演示；不是生产客服系统，也不是官方 τ-bench 的完整实现。

另有独立的 [τ-bench 测试场景接口](benchmark/README.md)，支持加载本地官方 policy、完整数据库及 Python 工具，默认关闭，不改变 demo 默认配置。提供后台单独测试及真实 Realtime / Gateway / A2A / MCP 文本 harness 测试脚本；尚未覆盖 ASR / TTS、物理语音及官方全量调度。

后台 Agent 会在内存中保留最多 50 轮已完成任务的请求和最终回复（当前请求之外最多
携带 49 轮）。Gateway 会为同一客户的后续 Task 复用服务端签发的 A2A Context；
待确认操作的预览只属于原 Task，不会作为可复用授权写入历史。重置业务会话、换客户
或重启后台 Agent 后会重新积累历史。

## 能做什么

| 场景 | 已实现 |
|---|---|
| 零售 | 邮箱或姓名 + 邮编核验、订单查询、商品款式/库存查询、取消订单、整单/部分退货、改收货地址 |
| 航空 | 会员号或姓名 + 证件后四位核验、预订/航班查询、航班搜索、退票、改签、改舱、加托运行李、按细则发放补偿 |
| 业务边界 | 未核验拒绝查询私有订单，时限/资格判定，超权限或 policy 缺口转人工 |
| 确认流程 | 写操作先预览；明确同意后提交原操作，拒绝/取消/超时撤销批准 |
| 客服工作台 | 语音通话、对话记录、核验状态、订单/预订数据、工具调用审计、重置/换客户 |
| 人工坐席台 | 查看已转人工的客户状态与上下文 |
| Policy 配置台 | 抽取与人工裁决、决策表/流程/工具面编辑、覆盖度检查、数据库编辑、变更预览、备份与审计 |

零售换货尚未实现。转人工是 demo 状态交接，不是外部呼叫中心集成。

## 快速启动

在仓库根目录执行。Node.js 版本要求以根目录 `package.json` 为准。

```bash
npm install
npm run example:customer-service:install
```

创建 `examples/customer-service/.env.local`，参考 [.env.example](.env.example)。
已有配置不要覆盖。至少填写：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
DASHSCOPE_MODEL=qwen3.8-flash
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
QWEN_AUDIO_REALTIME_VOICE=longanqian
```

后台模型使用 DashScope Chat Completions；语音前台使用独立的 Realtime WebSocket API。
密钥需要相应模型权限。自定义语音端点时填写 `QWEN_AUDIO_REALTIME_BASE_URL`。
示例会加载本目录与仓库根目录的 `.env.local`，进程环境变量优先，本目录文件优先于根目录文件。

```bash
npm run example:customer-service           # 零售：五个进程
npm run example:customer-service:airline   # 航空：五个进程
npm run example:customer-service:both      # 两组同时运行：十个进程
```

| 页面 / 服务 | 零售 | 航空 |
|---|---|---|
| 客服工作台（从这里开始） | http://127.0.0.1:4620 | http://127.0.0.1:4720 |
| 人工坐席台 | http://127.0.0.1:4630 | http://127.0.0.1:4730 |
| Gateway 自带界面 | http://127.0.0.1:18889 | http://127.0.0.1:18989 |
| 业务服务 | http://127.0.0.1:3110 | http://127.0.0.1:3210 |
| A2A Agent | http://127.0.0.1:3120 | http://127.0.0.1:3220 |

工作台需要麦克风授权。不要同时用工作台和 Gateway 自带界面控制同一通话。
HTTP / WebSocket 请求经工作台同源代理，避免直接跨端口请求 Gateway。

配置台独立启动，不占通话关键路径：

```bash
npm run example:customer-service:console   # http://127.0.0.1:4610
```

Ctrl+C 结束 bootstrap 启动的进程组。业务状态常驻内存；进程重启不会恢复订单修改。

## 建议这样演示

每条独立场景前，使用工作台的“重置本位客户”或“换一位客户”。

### 零售

1. 提供注册邮箱 `liming3021@example.com`，查询订单。
2. 请求取消 `#W1082334`，听完商品、退款金额和到账方式的预览。
3. 先回答“不取消了”：订单应保持未发货；再次请求，回答“同意取消”：订单才变更。
4. 用“陈静 + 邮编 510620”测试没有邮箱的第二种核验方式。

其他边界：`#W3301887` 涉及超权限金额；`#W3376900` 是 policy 未规定退货窗口的家具。
先核验相应订单所属客户；可在配置台查看 demo 数据。系统应说明边界并转人工，而不是编造规则。

### 航空

1. 提供会员号 `CY10023841`，查询预订 `CYR8801`。
2. 搜索同航线航班，请求从 `CY1201` 改到 `CY1203`。
3. 听完改签手续费与差价，明确同意后检查预订、座位库存和支付记录。
4. 拒绝批准时不能改变预订；已飞或不符合资格的操作应被业务服务拒绝。

航班日期按 demo 基准平移到当前时间，请查询实际结果，不要照抄固定日期。

## 前后台如何协作

```text
客服工作台 ── Gateway 协议 ──► Gateway ── A2A ──► 后台 Agent
    │                            │                    │
    │ HTTP / SSE                 │ frontend MCP       │ backend MCP
    └────────────────────────────┴────────────────────┘
                                 ▼
                         service：唯一业务状态源
                                 ▲
                      人工坐席台读取状态与交接信息

Policy 配置台 ──► domains/<domain> 配置和 gateway 工具面配置
```

前台面是后台面的子集，包含核验、只读查询和 `transfer_to_human`。
需要批准的写操作只在后台；两面调同一个 executor，避免前后台各维护一份规则或状态。

`policy.md` 通过当前域的 knowledge 检索源供前台查询；公网搜索和用户画像在本示例中关闭。
资格、权限和金额规则主要由 `guards.json` 决策表执行。
`flows.json` 注入后台 prompt 安排步骤顺序，不是强制工作流引擎。

### 批准不是模型填一个 true

1. 写工具第一次调用只生成预览和内部 `data.approval = { token, preview }`，不写库。
2. executor 保存工具名、原参数、令牌和任务上下文，发布 `auth_required`。
3. 客户只收到可读预览；令牌与内部调用指令不进入 A2A 确认文本或模型消息。
4. 前台通过 `respond_agent_input` 返回决定，A2A adapter 在消息 metadata 中携带
   `qwenAudioInputResponse = { kind: 'authorization', action }`。
5. 授权必须明确为 `accept` / `decline` / `cancel`，缺失或非法动作报错。
   只有明确 accept 才由 executor 提交保存的工具与参数；拒绝、取消、超时清理并撤销令牌。
6. 提交结果交回模型继续原任务。后续写操作逐笔取得新批准，不共用同意。
   最终结果不再混入历史进度和旧确认问题。

批准按 taskId 隔离，有效期五分钟，一次性消费，绑定动作与对象。
改签 / 改舱进一步绑定目标、原预订状态和报价；确认参数漂移或预订变化则拒绝提交。
令牌保护不能代替真实客户同意识别：语音前台仍需正确理解客户答复。
当前本地 A2A 服务没有生产级鉴权，不应暴露到公网。

### 重置与换客户

工作台先停止音频并关闭旧连接，再通过 `POST /api/customer-service/reset` 协调：

- 取消旧对话的 Gateway 任务；
- 清理后台挂起任务、撤销批准，等待运行中的任务退出；
- 重置业务库与核验状态；
- 用新的对话 ID 重连，旧历史不再进入新对话。

新对话 ID 保存在当前标签页的 sessionStorage，刷新可继续；MCP 业务 sessionId 仍固定不变。
旧历史文件保留，不执行删除。清理失败时暂停通话并提示重试，不假装已换客户。
直接调用 service 的 `reset` / `new-customer` 只清业务状态，不执行跨进程协调。

## Policy 配置台

管理员可以修改决策表、流程、前后台工具归属和 demo 数据。
抽取运行三次，用结果分歧辅助人工裁决，而不是只相信模型自评 confidence。
缺口、冲突和无法定位到 policy 原文的候选需要人工处理。

“预览并应用”先校验、显示 diff 和覆盖度，再写入域配置。
配置变更备份到 `.runtime-console/backups/`，并记录审计；中途写入失败会回滚。

| 改动 | 生效方式 |
|---|---|
| 决策表 / guards | 下一次工具调用 |
| 流程 / flows | 下一个后台任务 |
| Gateway 工具面 | 重启对应域的 Gateway |
| demo 数据库 | 重置业务会话或重启服务 |

## 测试与评测

```bash
npm run test:customer-service             # 自动安装示例依赖，再跑各组件测试
npm run test:customer-service:smoke       # 核心内存回归，不需要模型 Key 或本地端口
npm run example:customer-service:lint
node --test server/test/a2a*.test.mjs     # 框架 A2A adapter 回归
```

自动测试覆盖核验、工具面、决策表、写操作、MCP / A2A 批准、任务取消/超时、
多步骤逐笔批准、换客户协调、语音客户端控制、配置应用和输出审计函数。
集成测试使用桩模型和临时本地端口，不调用付费模型；单测通过不代表真实语音已端到端通过。

与 τ-bench 的关系：工具和零售数据参考其结构，但本示例裁剪并本地化了数据与 policy，
默认 demo 不接官方模拟用户与评分器；可选测试接口与脚本见 benchmark 说明，不能将桩模型回归成功率当成官方分数。
正式评测需固定版本，对齐官方环境，并覆盖前台核验、委派、批准和任务恢复，而不是只测后台模型。

## 已知限制

- 每个域仍是单通话 demo：前后台 MCP 使用进程固定的 `CS_SESSION_ID`。
  新对话 ID 防止旧上下文进入新客户，但不提供多客户并发业务隔离。
- 业务库、任务和批准主要在内存中，进程重启后的恢复、幂等事务和持久化未完善。
- 前台语音识别、客户同意识别、工具选择和措辞仍需真实语音回归与模拟用户评测。
- 零售换货、完整官方 τ-bench 工具和任务集未覆盖。
- 出口审计函数和 HTTP 端点已实现，但尚未自动接到实时语音输出链路，也不是播报前拦截器。
- 工作台、Agent、业务 API 和配置台是本地开发服务，包含管理与重置能力，无生产级访问控制。

## 目录

```text
bootstrap/     环境加载、两域进程组启动
client/        客服工作台、同源代理、换客户协调、音频控制
desk/          人工坐席台
gateway/       A2A 装配、人设、前台工具面、policy 检索
agent/         模型、后台 MCP 客户端、任务和批准生命周期
service/       内存状态、HTTP / SSE / MCP、业务工具、输出审计
console/       Policy 抽取、裁决、配置和数据库编辑
domains/       retail / airline 的 policy、guards、flows 和 demo 数据
```
