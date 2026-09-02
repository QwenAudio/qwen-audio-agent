# A2A Backend Adapter

可选 A2A Backend Adapter 用于把一个远程 A2A Agent 接到现有 `BackendPort`。它使用
官方 A2A JavaScript SDK 完成 Agent Card 发现、协议协商、消息提交、Task 查询与取消、
Artifact 解码。A2A 对象只存在于 Adapter 内部；Gateway、Task Runtime、语音前台和
客户端仍使用协议无关的现有契约。

这是供自定义 Gateway 启动器使用的编程扩展，不新增 `AGENT_PROTOCOL` 值，也不在桌面
设置中增加选项。

## 连接 Agent

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import { createBackendAgentHost } from 'qwen-audio-agent/backend-adapter-sdk'
import {
  createA2ABackendAdapter,
} from 'qwen-audio-agent/a2a-backend-adapter'

const backend = createA2ABackendAdapter({
  agentCardUrl: 'https://agent.example/.well-known/agent-card.json',
  token: process.env.MY_A2A_TOKEN,
})
const agent = createBackendAgentHost(backend)
const application = createGatewayApplication({ agent })

process.once('SIGTERM', () => application.close())
```

`agentCardUrl` 是完整的公开 Agent Card URL，只允许 HTTP/HTTPS，且不能在 URL 中携带
用户名或密码。Bearer 认证使用 `token`；其他认证方式使用 `headers`：

```js
const backend = createA2ABackendAdapter({
  agentCardUrl: process.env.MY_A2A_AGENT_CARD_URL,
  headers: async () => ({
    Authorization: `Bearer ${await refreshAccessToken()}`,
    'X-Tenant': 'tenant-one',
  }),
})
```

配置的 Header 同时用于 Agent Card 发现和 Task 请求，不会由 `describe()` 返回。也可以
直接传入标准 `agentCard` 对象。Adapter 支持 JSON-RPC 与 HTTP+JSON/REST，并按 Agent
Card 的声明顺序选择首个兼容接口。官方 SDK 的 A2A 0.3 兼容默认开启，可通过
`legacyCompat: false` 关闭。

## Task 投射

- 规范 Task 指令成为用户 Message 文本；前台历史、记忆、Gateway ID 和路由元数据
  不会发送给远程 Agent；
- 输入附件变成带 MIME 类型的标准 A2A raw 或 URL Part；
- Agent Card 声明 Streaming 时优先消费原生事件；否则请求非阻塞执行并轮询 `GetTask`；
- A2A 状态、Message 和 Artifact 分别投射为 `backend.activity`、`backend.message` 和
  `backend.artifact`，持续更新同一 Gateway Task；
- 最终 Artifact 投射为标准 Gateway Artifact，最终 Agent 状态 Message 提供自然播报材料；
- 获得远程 Task ID 后使用 `CancelTask`；尚未获得 ID 时仍可中止本地请求。

Gateway `taskId` 不会成为远程 Task 身份。二者映射只在当前提交执行期间存在，远程 ID
不会越过 `BackendPort`。

## 状态映射

| A2A Task 状态 | Backend 状态 |
| --- | --- |
| `SUBMITTED` | `submitted` |
| `WORKING` / `UNSPECIFIED` | `working` |
| `COMPLETED` | 完成结果 |
| `FAILED` / `REJECTED` | 失败结果 |
| `CANCELED` | 取消结果 |
| `INPUT_REQUIRED` | `input_required`；等待 `respondInput` 后继续同一远程 Task |
| `AUTH_REQUIRED` | `auth_required`；上浮远端请求，收到输入后继续同一远程 Task |

A2A 不为 `AUTH_REQUIRED` 后的凭据或审批决定规定统一语义。因此 Adapter 只把 Agent 的
状态消息投射为协议中立的输入请求，不猜测凭据；回答作为带相同远程 Task ID 与 Context ID
的新用户 Message 发回，Gateway 中原来的 Task 始终保持活动。

## 配置项

- `agentCardUrl` 或 `agentCard`：必须提供一种发现来源；
- `token`、`headers`、`fetchImpl`：认证与传输扩展；
- `acceptedOutputModes`：期望接收的结果 MIME 类型；
- `pollIntervalMs`：Task 轮询间隔，默认 1 秒；
- `timeoutMs`：可选的单 Task 超时；默认关闭，由协议完成或显式取消结束长任务；
- `requestTimeoutMs`：Agent Card 发现等无 Task 信号请求的超时，默认 30 秒；
- `legacyCompat`：官方 A2A 0.3 兼容，默认开启；
- `clientFactory`：测试或高级传输注入。

派生 Adapter 仍应运行公共 Backend Adapter conformance suite。内置 A2A Adapter 已覆盖
完整 conformance 测试，以及 A2A 1.0 HTTP+JSON 的 Agent Card 发现、任务回环和流式事件测试。
