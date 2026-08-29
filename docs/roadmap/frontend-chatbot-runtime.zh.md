# Realtime Voice Chatbot Runtime Roadmap

> 状态：提案
>
> GitHub 跟踪：[#185](https://github.com/QwenAudio/qwen-audio-agent/issues/185)
>
> 范围：在保持单一后台 Agent 的前提下，将 qwen-audio-agent 重构为边界清晰、
> 可扩展、相对标准化的实时语音 Chatbot Runtime，并通过异步 Work Bridge 接入
> 用户自己的办事 Agent。

## 1. 产品定义

qwen-audio-agent 由两个彼此解耦、对用户表现为一个助手的运行时组成：

1. **Realtime Voice Chatbot** 始终拥有用户对话。它负责语音、文本、图片、附件、
   对话上下文、记忆、Search、Knowledge/RAG、低延迟前台工具和结果表达。
2. **Backend Action Agent** 负责访问文件、代码、应用、设备和外部系统，执行长耗时、
   多步骤或需要权限的工作。它使用自己的模型、配置、工具、MCP、Skill 和 Session。

`spawn_thinking` 是二者之间唯一的模型可见工作交接入口。它只提交用户目标和输入引用，
不允许前台选择后台 Session、执行方式、委托策略、工具或子 Agent。

当前版本只激活一个用户选择的后台。多后台路由不属于本 Roadmap。

## 2. 架构不变量

以下规则由文档、依赖检查和测试共同保证：

1. 没有后台 Agent 时，前台仍能完成正常聊天、记忆、Search，以及通过可选 Provider
   注入的知识检索。
2. 后台排队、运行、等待权限或失败，不阻塞前台继续对话。
3. `spawn_thinking` 只等待受理回执，不等待后台工作完成。
4. 后台结果由前台在安全的语音窗口自然表达，且只交付一次。
5. Frontend Runtime 不依赖 ACP、OpenCode、OpenClaw 或任何具体后台实现。
6. Work Runtime 不包含 Session、MCP 协调工具或后台拓扑知识。
7. Backend Adapter 不直接向客户端发送事件，只产生标准 Work 事件和 Artifact。
8. Realtime Provider 不调用后台，不解释 Work 执行策略。
9. 客户端只消费公开协议，不自行推导 Gateway 内部状态机。
10. 知识 Provider 管理自己的索引生命周期；前台记忆提取仍是 System Job，而不是用户
    Backend Work。

## 3. 目标边界

```text
Desktop / WebUI / TUI
          │ AG-UI compatible events + qwen.audio extensions
          ▼
Gateway Transport
          ▼
Frontend Chatbot Runtime
├── Realtime Session / Conversation Context
├── Frontend Tool Runtime
├── Search / Knowledge
├── Memory / Notes / Reminder
└── Presentation Runtime
          │ WorkSubmissionPort
          ▼
Work Runtime
├── State / Queue / Authorization
├── Artifact / Notification / Recovery
└── Scheduler
          │ BackendPort
          ▼
Single Backend Runtime
          ▼
ACP / future A2A / custom Backend Adapter
```

依赖方向固定为：

```text
Transport → Application → Domain ← Adapter
```

## 4. 核心契约

### 4.1 RealtimeProviderPort

Realtime Provider 只负责将供应商协议投射成统一的实时会话事件：

```js
{
  connect,
  updateSession,
  sendAudio,
  sendInput,
  sendToolResult,
  createResponse,
  cancelResponse,
  close,
  capabilities,
  subscribe,
}
```

DashScope、OpenAI-compatible、Speech-to-Speech 和私有 Provider 都实现该 Port。

### 4.2 FrontendTool

```js
{
  name,
  description,
  inputSchema,
  outputSchema,
  policy: {
    mode: 'inline' | 'background' | 'control',
    readOnly,
    requiresApproval,
    timeoutMs,
    maxResultBytes,
    maxCallsPerTurn,
  },
  execute,
}
```

- `inline`：在当前对话轮次中返回，例如 Search、RAG、Time、Memory。
- `background`：只返回受理回执，当前只有 `spawn_thinking`。
- `control`：查询、取消和权限等控制操作，不创建新 Work。

### 4.3 Work

Task 是 Gateway 管理的异步工作单元，不镜像后台内部任务图。它只使用一个短
`task_id` 贯穿受理、查询、取消、事件和结果交付，并包含 owner、conversation、turn、
objective、多模态输入、状态、活动、权限、Artifact、Presentation 和时间戳。

公共状态向 A2A Task 语义靠拢：

```text
submitted → working → completed
                  ├→ input_required
                  ├→ auth_required
                  ├→ failed
                  └→ cancelled
```

`queued`、`delegated`、`finalizing` 和 `cancelling` 等仅作为 Gateway 内部 phase，
不得成为 Backend Adapter 的前置假设。

### 4.4 BackendPort

```js
{
  describe,
  start,
  health,
  submit,
  status,
  cancel,
  respondAuthorization,
  respondInput,
  subscribe,
  close,
}
```

ACP Session、协调 Prompt、协调 MCP 和原生委托全部属于 ACP Adapter 内部。
每个 Adapter 必须实现完整方法面，并在组合边界接受校验。可选能力由 `describe()` 声明，
不支持时必须明确拒绝，不能依赖“缺少某个函数”来推断。`submit`、`status`、`cancel` 与
`respondAuthorization`、`respondInput` 只操作 Gateway `taskId`，后台私有 Session 与远程任务 ID 不越过端口。
后台追问不会结束当前 Task：Adapter 发出有界输入请求，Gateway 经 `respondInput`
把用户回答交回同一 Task 后继续执行。因此一次后台调用返回不再等同于 Task 已完成。
AgentClient 只持有一个注入的后台实例。驱动选择、Profile 构造和协议专属依赖属于
Adapter Factory，不再由运行时门面承担。

### 4.5 Artifact 与 Presentation

Artifact 采用与 A2A 对齐的 `artifactId`、名称、描述和 Parts 结构。每个 Part 只包含
text、URL、base64 原始内容或结构化数据中的一种，并声明 MIME 类型。Authorization
是有界的 Work 决策请求，包含身份、状态、摘要、类别和时间戳，只转交决策，不承载凭据。
Presentation 只携带供前台表达的事实材料和投递策略，不携带必须逐字播报的脚本。

重启恢复是明确的 Work 策略：安全的提醒重新调度，可恢复的委托重新挂接，中断的执行只
失败一次，已经持久化的取消意图仍保持取消。结果投递采用持久化领取租约；确认送达先落盘
再发布事件，只有未确认或租约过期的结果才允许重新投递。

## 5. 标准协议策略

| 边界 | 策略 |
| --- | --- |
| Client ↔ Gateway | 逐步兼容 AG-UI 稳定事件；音频、播放、所有权和休眠使用 `qwen.*` 扩展 |
| Gateway ↔ Realtime Model | OpenAI Realtime-compatible Provider Port |
| 模型工具 | Function Calling + JSON Schema |
| 外部工具与数据 | MCP；普通 REST 服务可通过 OpenAPI Adapter |
| Gateway ↔ Backend Agent | BackendPort；内置 ACP 与 A2A Adapter，也可接自定义协议 |
| 多模态内容 | MIME Type + text / URI / binary / structured data Part |
| 可观测性 | 结构化日志；逐步接入 OpenTelemetry trace 语义 |

标准协议通过边界 Projector 或 Adapter 接入，不直接成为内部 Domain Model，避免协议升级
扩散到核心业务。

## 6. 前台能力边界

前台允许有界的短工具循环：总耗时、调用次数、结果大小均受 Tool Policy 限制，用户
插话时可立即终止当前前台循环。前台负责：

- 连续语音、文本和多模态对话；
- 对话历史、用户偏好、长期记忆、Notes 和 Reminder；
- Web Search、URL Fetch、引用；
- Full Context 与 Knowledge/RAG；
- 后台 Work 查询、取消和权限转述；
- 后台最终结果的自然表达。

后台私有能力包括：

- 文件系统、Shell、代码工程和应用操作；
- 手机、浏览器、桌面和硬件控制；
- 长时间、多步骤或高风险工作；
- Subagent、Session、执行计划和委托策略；
- 后台自己的 MCP、Skill、模型和工具。

## 7. 迁移阶段

### R0：架构冻结

- [ ] 合并本 Roadmap 与中英文架构 RFC。
- [ ] 为依赖方向增加静态检查。
- [ ] 为当前关键行为补齐 characterization tests。

完成条件：后续 PR 都能明确归属到一个 Domain 和一个公开契约。

### R1：协议与客户端状态

- [x] 为 Gateway Client/Server/Task 事件建立 Zod Schema。
- [x] 建立 Domain Event 与公开 Event Projector。
- [x] 增加 AG-UI 兼容投射层，不立即删除现有事件。
- [x] 提取共享 Gateway Client 和状态 Reducer。
- [x] 依次迁移 WebUI、TUI、Desktop。

完成条件：三个客户端不再各自解释 Work 和 Voice 状态机。

### R2：Frontend Chatbot Runtime

- [x] 提取 Realtime Session、Turn、Input、Playback 和 Presentation。
  - [x] 集中管理单连接内的 Turn 代次、关联与打断边界。
  - [x] 提取 Provider 音频/转写与手动输入生命周期。
  - [x] 提取响应关联、Playback 与 Presentation 生命周期。
  - [x] 提取 Realtime Provider Session 生命周期。
- [x] 建立 Frontend Tool Registry、Policy 和 Executor。
  - [x] 提取声明式 Registry 与可见性 Policy。
  - [x] 通过 Registry 管理的 Executor 统一执行入口。
- [x] 将现有工具逐个迁移，保持工具名与用户行为不变。
- [x] 将 `spawn_thinking` 固化为 background tool。
- [x] 增加有界短工具循环。

完成条件：增加新前台工具只需要定义、实现和测试，不修改 Realtime Gateway 主流程。

### R3：Work Runtime

- [x] 从 TaskManager 提取 State Machine、Scheduler、Repository 和 Notification。
  - [x] 集中管理任务阶段、合法状态迁移与公开快照。
  - [x] 由独立 Scheduler 管理并发与 Lane 限制。
  - [x] 提取通知领取、租约、释放与送达状态。
  - [x] 提取持久化 Work 记录与短 Job ID 分配。
- [x] 区分 User Work 与 System Job。
- [x] 建立 Artifact 与统一 Authorization 模型。
- [x] 保持重启、取消和恰好一次结果投递语义。

完成条件：Work Runtime 不包含任何 ACP 或后台产品名称。

### R4：Backend Runtime

- [x] 定义并校验 BackendPort。
- [x] 将 AgentClient 收敛为 Single Backend Runtime。
- [x] 让 ACP Adapter 实现 BackendPort。
- [x] 将 Coordinator 和 Session 工具下沉到 ACP Adapter。
- [x] 为 Backend Adapter 建立 conformance test suite。

完成条件：新增非 ACP Adapter 不修改 Frontend、Work 或客户端代码。

### R5：完整前台能力

- [x] Web Search Provider、URL Fetch 和 Citation。
  - [x] 定义与供应商无关的 Web Search Port 和有界 Citation 模型。
  - [x] 增加按能力启用的前台工具与防 SSRF 的 URL Fetcher。
  - [x] 增加不额外调用大模型的可配置 MCP 搜索与实验性免 Key 兜底。
  - [x] 通过公开客户端协议投射 Citation。
- [x] 可选知识检索框架。
  - [x] 定义轻量、版本化的 Knowledge Retrieval Provider 协议。
  - [x] 将存储、解析、切分、索引、凭证和文档管理留在 Provider 或宿主应用边界内。
  - [x] 仅在注入 Provider 时注册一个有界的纯检索工具。
  - [x] 在不内置具体 RAG 的前提下覆盖生命周期、安全、引用和一致性测试。
- [x] 路由、引用、打断、重复播报和 Prompt Injection 评测。
  - [x] 增加不依赖供应商和线上模型的确定性前台评测命令。
  - [x] 直接驱动 Runtime 组件，不在评测代码中复制业务逻辑。
  - [x] 将模型语义质量评测与 CI 可保证的不变量明确分离。

完成条件：后台设置为 `none` 时，前台仍是完整的轻量 Chatbot。

### R6：开放生态

- [x] MCP Client 与逐工具授权/启用策略。
  - [x] 定义与供应商无关的 Source Contract、版本化配置、HTTP Transport、
    工具发现和失败关闭的只读策略。
  - [x] 把发现到的工具接入动态 Realtime 工具注册表与执行器。
  - [x] 在启用可写工具前增加通用授权链路。
- [x] OpenAPI Tool Adapter。
- [x] 轻量 Frontend Profile；暂不自创公开 Skill 标准。
  - [x] 用版本化本地清单组合助手画像、MCP 与 OpenAPI 配置引用。
  - [x] 保持密钥、用户记忆、Realtime Provider 和后台 Agent 在 Profile 边界之外。
- [x] Backend Adapter SDK 与示例。
  - [x] 发布 BackendPort、应用宿主包装和共用 conformance suite。
  - [x] 用非 ACP 内存 Adapter 验证无需修改前台与 Work Runtime。
- [x] 可选 A2A Backend Adapter。

完成条件：外部扩展通过标准协议或公开 SDK 完成，不修改核心运行时。

## 8. 仓库目标结构

```text
server/src/
├── app/                  # composition root
├── transport/            # HTTP / WebSocket / AG-UI projectors
├── frontend/             # Chatbot runtime
├── work/                 # user work domain
├── backend/              # backend port/runtime/adapters
├── providers/realtime/   # realtime provider adapters
└── platform/             # config/identity/persistence/logging/security

shared/                   # 迁移期公共协议与客户端运行时
packages/                 # 接口稳定后再拆 protocol/client/backend-sdk workspace
```

不进行一次性目录搬迁。每次移动必须伴随职责提取和测试。

## 9. 强制依赖规则

```text
frontend/        不得导入 backend/adapters/
work/            不得导入 ACP、Session 或具体后台
transport/       不得实现业务状态机
providers/       不得调用 BackendPort
backend/adapters 不得直接向客户端发事件
clients          不得自行推导 Gateway 内部状态
shared/protocol  不得依赖 server
```

## 10. 质量门禁

- `npm run lint`
- `npm test`
- `npm run release:check`
- 公共协议兼容测试
- 无后台聊天测试
- 后台工作不阻塞对话测试
- 打断不取消已提交 Work 测试
- 最终结果恰好一次播报测试
- Adapter 和 Provider conformance tests

重构 PR 默认不改变用户行为。行为变化必须独立提交、更新中英文文档并增加端到端测试。

## 11. 非目标

- 同时连接或自动路由多个后台 Agent；
- 将前台建设成编程 Agent 或通用长任务 Agent；
- 迁移到 Open WebUI、LiveKit 或其他完整平台；
- 立即替换现有 Gateway 协议；
- 自创新的 MCP、A2A 或 Skill 协议；
- 为了统一而暴露后台 Session 和内部任务拓扑。
