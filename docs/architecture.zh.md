# qwen-audio-agent 架构

本文档定义产品边界。违反这些不变性的变更属于架构变更，而非局部功能开发。

## 1. 用户可见模型

用户与一个 qwen-audio 助手对话。内部存在两个 qwen-audio-agent 层：

1. **实时前端** — 全双工语音、简单直接回答，以及基本的本地时间/记忆工具。
2. **后端 Agent** — 一个持久 Agent Session，负责处理所有需要工具、当前信息、文件、应用程序、代码或多步工作的请求。

后端可以是 OpenCode、OpenClaw、Qoder、Qwen Code、Kimi Code、Pi 或其他 ACP 兼容 Agent。
它内部可以使用工具、技能、Agent 或其他 Session。这些都是后端私有实现细节，
不会创建额外的 qwen-audio-agent 层。所有后端通过一个 ACP 客户端和一个
共享协调适配器连接；后端特定的启动和能力行为位于已注册的驱动程序中。

## 2. 非阻塞请求流

```text
final ASR
   │
   ├─ immediately answerable ───────────────► Realtime speech
   │
   └─ requires work
          │ spawn_thinking(objective)
          ▼
      Work accepted
          │ response returns to Realtime immediately
          ▼
      owner FIFO queue
          │
          ▼
      fixed Backend Agent Session
          │ the backend decides how to work
          ▼
      final presentation
          │ waits for a safe duplex insertion window
          ▼
      Realtime naturally speaks the result
```

`spawn_thinking` 永不等待所请求的工作完成。用户可以在多个 Work 项排队期间继续
说话。对于每个 owner，一次只有一个 Work 项被发送到后端 Agent Session。

## 3. 实时边界

实时前端有意保持极小的工具集——工具少、延迟低、无多步编排。基础工具为：

```text
spawn_thinking
schedule_reminder
cancel_agent_task
get_agent_task_status
get_current_time
memory
notes
respond_agent_permission
```

`memory` 通过一个扁平接口维护两份普通 Markdown 文档。每次调用只执行一个
原子操作：`read`、`append` 或 `replace`；`replace` 使用唯一匹配的原文定位，
找不到或匹配多处时安全失败。同一轮可逐项调用多次，Gateway 合并后续回应。
两个文档的权限边界不同：

- `user` 是当前用户的长期个性化覆盖：称呼、关系、助手在其面前的名称、语言、表达
  风格和默认做法。它作为用户授权的指令材料注入，覆盖 `ASSISTANT.md` 中的实例级
  默认人设，并服从用户当前的话语。
- `memory` 是只用于理解和回答的持久事实与决定，绝不作为行为指令。两者按是否具有
  行为权威区分，而不是按主题机械分类。

两者都不能授权泄露内部结构、跳过权限检查，或改变任务和安全协议。随包的
`PROMPT.md` 是不可被个性化覆盖的核心规则；本地 `ASSISTANT.md` 只保存助手实例的默认
身份、人格、关系定位和表达风格。首次启动从随包模板创建，升级不覆盖，下一次语音会话
读取修改。助手不会通过记忆工具修改它。

除显式工具写入外，会话结束提取器还会整理遗漏的明确用户指令和持久事实，分别路由到
`USER.md` 与 `MEMORY.md`。它与 Realtime 工具共用同一个上下文服务，不直接写文件，
永远不能修改 `ASSISTANT.md`，并会拦截文档边界错误和敏感内容。补丁结果记录在本地审计
文件中；未配置文本模型 API 密钥时自动静默禁用。

`notes` 将用户命名的列表（购物清单、待办事项、阅读列表）作为前端自有的易失集合
进行管理：单次调用即可完成添加、展示、匹配移除、清空和删除，无需后端参与。列表是
条目数据，而非记忆；稳定事实保留在 `memory` 中，列表条目绝不会被写入用户偏好或
事实记忆。条目和列表解析首先匹配精确文本，然后匹配唯一的不区分大小写子串，
否则报告歧义并将候选名称返回给模型以澄清。`clear` 和 `drop` 额外要求当前轮次
用户明确表达破坏性意图。

`get_agent_task_status` 是生命周期、进度和中间结果问题的唯一实时入口。
Gateway 直接回答非委派 Work。对于 `delegated` Work，它创建一个隐藏的、
高优先级的控制查询，使用协调器调用 `session_status`。该查询排在已运行的
协调器轮次之后、普通排队 Work 之前，其结果通过正常的异步通告路径传递。
它不作为用户 Work 项暴露，也不能成为后续状态或取消请求的隐式目标。

实时前端没有以下工具：

- 选择、创建、继续或取消后端 Session；
- 选择同步、异步、前台或后台执行；
- 选择后端执行策略；
- 选择工具、Agent 或子 Agent。

`respond_agent_permission` 是实时前端不控制后端执行这一规则的唯一例外。
它只能转发由 Gateway 提供的、针对待处理的、owner 作用域权限请求的明确当前轮次
用户决策。它可以理解自然的肯定或否定措辞，如"可以"或"不允许"，但不能在没有
当前轮次用户话语的情况下虚构同意、创建请求、选择工具或修改后端权限策略。
回复仅限于 `always` 和 `reject`；`always` 在可用时使用后端的 Session 作用域
权限选项。

传递给 `spawn_thinking` 的 `objective` 是对用户请求的保守解释，而非执行计划。
最近的语音上下文会单独包含在后端 Agent 信封中，因此诸如"继续那个页面"之类的
引用仍然可以理解。final ASR 仍然是事实来源。当前轮附件由 Gateway 自动随任务
传递；只有任务明确依赖此前轮次的图片或文件时，前台才通过可选的 `input_refs`
引用 Gateway 分配的会话内输入 ID。没有多模态输入的调用保持原协议不变。

## 4. 固定后端 Agent Session

ACP 适配器为每个 owner 和后端拥有一个持久协调器 Session 身份：

```text
qwen-audio-agent:<owner>:backend
```

Gateway 在该稳定键之后存储原生 ACP Session ID，并在后续轮次调用
`session/resume`。项目委派同样在其记录的工作目录中恢复选定的原生 Session，
因此语音发起的工作保留在后端自己的 Session 历史中，而非 Gateway 副本中。

语音浏览器会话 ID 和 Work ID 不会更改该身份。因此，新的语音对话会继续使用
相同的后端 Agent 上下文。

Gateway 队列和 ACP 适配器都对写入进行串行化。这种双重保护防止并发消息在一个
后端 Session 内部发生竞争。

后端 Agent 拥有自己的执行策略。qwen-audio-agent 提供用户请求、最近的语音上下文、
本地偏好和最终响应格式；它不指导后端 Agent 如何使用后端特定能力。

## 5. Work 状态

qwen-audio-agent Work 记录是交付回执，而非后端内部任务图的镜像。

```text
queued → running ─────────────────────────→ completed
   │        └→ delegated → finalizing ────────┘
   └────────────→ cancelling → cancelled
                            ↘ failed
```

公共字段仅限于用户请求、时间戳、最终结果/错误、通用工具活动、有界的待处理权限
摘要和通知状态。不存在执行模式、交付模式、子 Agent 状态、后端权限标识符、
后端拓扑或后端取消内部信息。

UI 将 `queued` 和 `running` 呈现为相同的"处理中"状态。队列位置是内部调度细节，
不会改变用户的双工对话。

活跃 Work 在 Gateway 重启后无法安全恢复，因此会变为 failed 并附带明确的重启原因。
已完成的结果和通知交付状态会被持久化。

## 6. 进度动画

进度是可观测性，而非控制。ACP 适配器将标准 `session/update` 通知投射为通用活动：

- 工具名称、有界的用户安全详情和运行中/已完成状态；
- 文本/推理活动仅表示为"整理结果"。

UI 将此映射为稳定的短语，如"搜索中"、"读取中"、"生成图像"或"整理结果"。
Session ID、子 Agent ID、原始权限载荷和原始推理不显示。待处理权限可以在
类密钥值被脱敏后，显示精确的有界操作或命令，以便知情同意。

活动绝不会产生语音状态更新，也绝不影响队列。

## 7. 最终结果交付

后端 Agent 返回一个最终呈现：

```json
{
  "work_id": "work id",
  "state": "completed",
  "mode": "respond",
  "presentation": {
    "speech": "concise result material",
    "inline": null
  }
}
```

`speech` 是语义材料，而非脚本。实时前端会将其适配到实时对话中。`inline` 携带
Markdown、代码或链接，用于共享时间线。

已完成的结果优先返回到发起对话。在全新连接时，可以恢复同一 owner 的旧对话中
未完成的结果。可续期声明防止两个实时前端呈现相同结果。结果被注入实时上下文，
仅在播放完成后标记为已交付。如果用户打断、正在说话或有其他响应待处理，
交付会等待并重试，不会重复注入上下文。重试有次数上限，因此一个格式异常的结果
不会阻塞后续完成。

当后端 Agent 将工作交给另一个原生后端 Session 时，中间传输响应为：

```json
{
  "work_id": "work id",
  "state": "delegated",
  "mode": "delegate",
  "delegation_id": "opaque run id",
  "target_session_id": "opaque backend Session id",
  "presentation": {
    "speech": "a natural confirmation authored by the backend Agent",
    "inline": null
  }
}
```

此响应绝不是用户可见的完成。适配器立即让后端 Agent 自然地完成这个简短的
工具后响应，将原始 Work 移至 `delegated`，并释放后端 Agent 串行化锁和
Work 调度通道。因此，其他语音请求可以在目标 Session 运行期间使用协调器。
适配器独立地保持 Work 生命周期和事件订阅存活。只有与委派 ID 关联的匹配 ACP
目标提示完成才能完成 Work。然后适配器短暂重新获取后端 Agent 锁，并将经验证的
结果发送给它进行最终呈现。繁忙的目标、空结果、无关的 Session 更新或旧结果
都无法完成 Work。

正常的后端请求超时分别适用于初始协调器轮次和最终呈现轮次。当适配器在等待
委派 Session 时不适用该超时。在该间隔内，只有显式 Work 取消或后端关闭才会
取消目标 Session。

取消是确认式的，而非乐观式的。`queued` Work 在本地取消。`running` 或
`finalizing` Work 中止其活跃后端请求。对于 `delegated` Work，首先请求空闲的
协调器调用 `session_cancel`；如果协调器 Session 被占用，ACP 适配器直接向精确
关联的目标 Session 发送 `session/cancel`。Work 保持 `cancelling` 状态，
直到其中一条路径确认停止，然后变为 `cancelled`。停止失败则变为 `failed` 并
附带取消错误。在适配器直接中止后，Gateway 会记录一个取消事实，并在下一个安全的
协调器轮次中注入一次。这样可以在不延迟取消或重复停止的情况下协调协调器的历史。

委派的 `presentation` 由后端 Agent 使用正常推理编写，并作为开始确认立即播报。
它可以解释创建了什么、提交了什么或计划了什么，但它不是最终结果。适配器仅在
异步 Session 工具已经成功但后端轮次未能完成时，作为超时回退中止后端轮次。

## 8. 后端内部能力

对于接受客户端提供的 MCP 服务器的 ACP 后端（包括 OpenCode、Qoder、Qwen Code 和
Kimi Code），Gateway 向协调器注入相同的五个工具：Session list、start、
send、status 和 cancel。OpenClaw ACP 不接受客户端提供的 MCP 服务器，
因此相同的协调契约映射到 OpenClaw 的原生 Session 工具。`session_start`
和 `session_send` 返回不透明的委派 ID。在任一成功后，后端 Agent 不得轮询、
重复工作或从自己的上下文中回答；适配器负责等待、取消、权限路由和结果关联。

`session_status` 仅用于观察。如果查询失败，后端 Agent 必须报告失败；
不得使用原生工具检查目标目录或复制委派的工作。

前端代码不得依赖于选择了哪个内部能力。前端任务快照只能暴露有界的标题和
通用委派状态，绝不暴露委派 ID、目标 Session ID、目录或原始事件。

## 9. 依赖方向

```text
WebUI / TUI / Desktop
   ↓ WebSocket and HTTP
Realtime Gateway
   ↓ spawn_thinking
Work queue
   ↓
backend agent envelope
   ↓
Shared ACP adapter
   ↓
OpenCode ACP, OpenClaw ACP bridge, Qoder ACP,
Qwen Code ACP, Kimi Code ACP, or another ACP Agent
```

后端特定的 API 细节仅属于 `server/src/agent`。实时工具不得导入后端适配器。
UI 仅消费公共 Work 事件和最终时间线内容。包级别的 `shared` 模块是基础运行时
工具；server `core` 和 `process` 可以依赖它们，但它们不得依赖 server 层。

Gateway 可以将不可变的 `web/dist` 产物作为部署便利来提供，但这仅是静态托管。
Gateway 源码不得导入 UI 组件、呈现文本、样式、终端行为或桌面行为。
所有三个 UI 拥有自己的渲染，并将结构化协议字段映射到各自的标签和交互模式。

## 10. 进程所有权

Gateway 是唯一的核心产品服务。后台生命周期由共享的 `owned/external` 归属模型管理：

- `owned`：Gateway 启动后端所需的本地进程，并在退出时停止它们。后台原生进程负责
  加载自己的用户配置、模型、工具和 MCP；适配器只提供协议参数和必要的公共能力。
- `external`：仅适用于声明了外部服务能力的后端。Gateway 不启动、改端口或停止该
  后台，只通过后端公开的协议地址连接，把配置与状态完全留给外部服务管理。

后台服务归属与 ACP 连接方式是两个相互独立的维度。每个后台 profile 声明一个
`acpConnection`；连接工厂当前实现 `process`，即启动一个本地 ACP stdio 子进程。
未来的远程 ACP bridge 可以新增另一种连接类型，而无需修改协调、权限、Work 或
Session 生命周期代码。声明外部后台服务，并不意味着 ACP 连接也自动变成远程连接。

每个后台通过一份经过校验的 Plugin 契约注册。目录项统一拥有身份、安装、原生配置
入口、进程环境和归属元数据；Agent Driver 与 Runtime Driver 必须显式声明完整的布尔
能力，缺失或互相矛盾时在启动阶段直接拒绝。后台子进程只接收跨平台运行所需的系统
变量和当前 Plugin 声明的凭证命名空间，Gateway 身份、Realtime、Memory 以及其他
后台的密钥不会跨过该边界。通用 ACP 命令如确有需要，可通过
`QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` 显式列出额外变量名。

HTTP/WebSocket 应用由可注入的组合根构造。导入应用工厂不会监听端口；CLI 和桌面版
使用轻量 bootstrap，而测试及未来客户端可以注入彼此隔离的 Agent、任务、会话、
配置和日志服务。

共享适配器通常拥有一个 ACP stdio 子进程，并随 Gateway 一起停止。OpenCode、Qoder、
Qwen Code 和 Kimi Code 直接作为 ACP Agent 运行；OpenCode 还可以额外启动其原生本地 Session
UI 服务。当前 `OPENCODE_BASE_URL` 表示这个 UI 服务地址，不是远程 ACP 执行端点，
因此 OpenCode 仍属于 `owned`。

OpenClaw 使用一个小型 ACP bridge。未显式配置地址时，Gateway 启动一个具有隔离运行时
和 Session 状态的 OpenClaw Gateway；显式配置 `OPENCLAW_BASE_URL` 时，则直接连接用户
已有的 OpenClaw Gateway，并且不读取、复制或修改其认证和 Agent 状态。此时服务归属为
`external`，ACP 连接仍是本地 `process`：本地官方 bridge 通过 WebSocket/WSS 连接远程
OpenClaw Gateway。外部连接不使用面向本地启动的短时端口探测，而由 bridge 报告实际的
网络、TLS 和认证结果。本地 bridge 退出只会中断 ACP 连接，不会触碰远程 Gateway。

Codex 也遵循同一边界：qwen-audio-agent 通过 ACP stdio 启动 `codex-acp`，该适配器再
通过自己的本地 stdio 协议启动 Codex App Server。Codex App Server 可以提供其他传输，
但它们不是远程 ACP 端点，不应泄漏进共享 ACP 适配层。

Desktop、TUI 和 WebUI 是可替换的 Gateway 客户端。Gateway 是当前 Realtime 模型的
唯一所有者，并通过 health 发布精确模型档案与传输能力。Desktop 只能配置和重启其
本地自有 Gateway；WebUI 与 TUI 将档案视为只读。借用或远程 Gateway 的模型不一致
会被拒绝，而不会被静默覆盖。关闭 UI 不会影响排队中的工作或固定的后端 Agent
Session。更改实时或后端行为的配置在下次 Gateway 启动时生效；更改 UI 的 Gateway
URL 仅重新连接该 UI。

macOS 桌面渲染器打包在应用程序内部。Electron 从私有的随机回环路径提供这些
不可变资源，并仅代理 Gateway HTTP API 和 Realtime WebSocket 流量。桌面 UI
资源不得从 Gateway 加载：重新构建桌面应用程序必须足以更新其外观，而无需升级
正在运行的 Gateway 前端。

## 11. 审查清单

合并变更前，请验证：

1. 后端工作排队或运行时，实时前端是否仍能对话？
2. 每个可执行请求是否进入同一个持久后端 Agent Session？
3. 任何前端 API 是否获得了 Session、子 Agent、权限或执行模式的知识？
4. 工具事件是否仅用于通用 UI 进度？
5. 完成播报是否仅来自最终后端 Agent 结果？
6. 任何 UI 是否开始管理 Gateway 或后端进程？
7. 打断是否能在不取消已提交 Work 的情况下推迟语音？
8. 测试是否覆盖 FIFO 串行化、固定 Session 复用、工具动画和交付重试？
