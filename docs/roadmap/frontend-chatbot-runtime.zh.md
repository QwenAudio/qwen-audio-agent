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

1. 没有后台 Agent 时，前台仍能完成正常聊天、记忆、Search 和 Knowledge/RAG。
2. 后台排队、运行、等待权限或失败，不阻塞前台继续对话。
3. `spawn_thinking` 只等待受理回执，不等待后台工作完成。
4. 后台结果由前台在安全的语音窗口自然表达，且只交付一次。
5. Frontend Runtime 不依赖 ACP、OpenCode、OpenClaw 或任何具体后台实现。
6. Work Runtime 不包含 Session、MCP 协调工具或后台拓扑知识。
7. Backend Adapter 不直接向客户端发送事件，只产生标准 Work 事件和 Artifact。
8. Realtime Provider 不调用后台，不解释 Work 执行策略。
9. 客户端只消费公开协议，不自行推导 Gateway 内部状态机。
10. RAG 索引、记忆提取等平台内部任务是 System Job，不是用户 Backend Work。

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

Work 是 Gateway 管理的用户工作回执，不镜像后台内部任务图。它包含内部 UUID、用户可见
job ID、owner、conversation、turn、用户原话、objective、多模态输入、状态、活动、权限、
Artifact、Presentation 和时间戳。

公共状态向 A2A Task 语义靠拢：

```text
submitted → working → completed
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
  subscribe,
  close,
}
```

ACP Session、协调 Prompt、协调 MCP 和原生委托全部属于 ACP Adapter 内部。

### 4.5 Artifact 与 Presentation

后台输出统一为包含 MIME 类型的 Artifact Parts。Presentation 只携带供前台表达的
事实材料和投递策略，不携带必须逐字播报的脚本。

## 5. 标准协议策略

| 边界 | 策略 |
| --- | --- |
| Client ↔ Gateway | 逐步兼容 AG-UI 稳定事件；音频、播放、所有权和休眠使用 `qwen.*` 扩展 |
| Gateway ↔ Realtime Model | OpenAI Realtime-compatible Provider Port |
| 模型工具 | Function Calling + JSON Schema |
| 外部工具与数据 | MCP；普通 REST 服务可通过 OpenAPI Adapter |
| Gateway ↔ Backend Agent | 当前 ACP；内部 Work 语义向 A2A 对齐；未来增加 A2A Adapter |
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

- [ ] 从 TaskManager 提取 State Machine、Scheduler、Repository 和 Notification。
  - [x] 集中管理任务阶段、合法状态迁移与公开快照。
  - [x] 提取通知领取、租约、释放与送达状态。
- [ ] 区分 User Work 与 System Job。
- [ ] 建立 Artifact 与统一 Authorization 模型。
- [ ] 保持重启、取消和恰好一次结果投递语义。

完成条件：Work Runtime 不包含任何 ACP 或后台产品名称。

### R4：Backend Runtime

- [ ] 定义并校验 BackendPort。
- [ ] 将 AgentClient 收敛为 Single Backend Runtime。
- [ ] 让 ACP Adapter 实现 BackendPort。
- [ ] 将 Coordinator 和 Session 工具下沉到 ACP Adapter。
- [ ] 为 Backend Adapter 建立 conformance test suite。

完成条件：新增非 ACP Adapter 不修改 Frontend、Work 或客户端代码。

### R5：完整前台能力

- [ ] Web Search Provider、URL Fetch 和 Citation。
- [ ] Knowledge Store、Document Extractor 和索引 System Job。
- [ ] Full Context、Retrieval Provider 和 RAG 工具。
- [ ] 路由、引用、打断、重复播报和 Prompt Injection 评测。

完成条件：后台设置为 `none` 时，前台仍是完整的轻量 Chatbot。

### R6：开放生态

- [ ] MCP Client 与逐工具授权/启用策略。
- [ ] OpenAPI Tool Adapter。
- [ ] 轻量 Frontend Profile；暂不自创公开 Skill 标准。
- [ ] Backend Adapter SDK 与示例。
- [ ] 可选 A2A Backend Adapter。

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
