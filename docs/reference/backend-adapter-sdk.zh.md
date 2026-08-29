# Backend Adapter SDK

Backend Adapter SDK 用于把非 ACP 办事系统接到 qwen-audio-agent。手机 Agent、硬件
Agent、HTTP 服务或其他任务运行时只需实现统一 `BackendPort`；前台语音、Task 队列、
权限转述和结果交付不需要修改。

## 导入

```js
import {
  createBackendAgentHost,
  defineBackendAdapter,
  verifyBackendAdapterConformance,
} from 'qwen-audio-agent/backend-adapter-sdk'
```

SDK 公开：

- `defineBackendAdapter`：在组合阶段校验完整方法面；
- `createBackendAgentHost`：把 Adapter 接到嵌入式 Gateway 的应用宿主；
- `BackendWorkRuntime`：把 Gateway Task 输入投射到 `submit`；
- `BackendEventType`、`backendEvent`：创建规范化后台事件；
- `verifyBackendAdapterConformance`：与内置 ACP Adapter 共用的契约测试；
- `assertBackendPort`、`BACKEND_PORT_METHODS` 和契约错误类型。

## BackendPort

Adapter 必须实现全部方法：

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

`start` 和 `close` 必须幂等。`status()` 不带 Task ID 时返回运行时状态；带 ID 时只查询
该 Gateway Task。`submit`、`status`、`cancel`、`respondAuthorization` 和 `respondInput` 共享同一个
`taskId`。后台私有 Session、远程 Task ID 和拓扑不能越过边界。

`submit(task)` 接收结构化内部 Task 和唯一的规范字段 `instruction`。Adapter
可以在内部使用路由与关联字段，但面向 Agent 的 ACP Prompt、A2A 文本 Part 或同类
输入只能包含 `instruction` 和协议原生附件 Part。不得把整个 Task、ID、owner、
生命周期、ASR 原文、工作目录、时区、前台记忆或聊天历史序列化为模型可见文本。
非模型型自定义 Adapter 仍可直接消费结构化 Task。

`submit` 的最终结果至少包含：

```js
{
  content: '供前台理解的事实结果',
  artifacts: [],
}
```

`content` 是前台 Chatbot 理解、概括和自然播报结果的唯一事实文本。Adapter
不得另行指定播报话术。文件、图片和结构化结果使用 `artifacts`；BackendPort
不规定 Conversation Client 的具体展示方式。

不要返回原始协议对象、Session ID、Token 或凭据。运行进度通过 `subscribe` 发布
`taskId`、`ownerId` 关联的标准后台事件；监听器异常不能中断任务。

Adapter 可以发布协议无关的可选观测信息，无需扩展 `BackendPort` 方法面：

```js
{
  type: 'backend.activity',
  taskId,
  ownerId,
  activity: {
    id: 'stable-observation-id',
    kind: 'thinking', // 也可以是 tool、plan、mode、session、status 等
    status: 'running',
  },
}
```

持续消息和产物分别使用 `backend.message` 与 `backend.artifact`。ACP
`session/update`、A2A 流式事件和自定义回调都必须先在 Adapter 内归一化，不得把协议
原始载荷传给 TaskManager 或前台。

`kind` 可扩展。通用展示字段包括 `status`、`message`、`label`、`detail`、`category`、
`tool`、`title`、`updatedAt`、`mode`、`completed` 和 `total`，也允许 Adapter 增加
自有字段。复用同一个 activity `id` 会更新该观测并把它置为最新活动。公共活动中
不得放入原始思考、凭据、私有任务 ID 或协议载荷。

权限请求通过 `backend.permission.requested` 发布规范化 permission。除有界 `summary`
外，Adapter 可以提供可选的安全 `operation`（`title`、`kind`、`description`、
`command`、`path` 和有界文件 `locations`）及 `approvalScope`。公共 `session` 作用域
仅表示当前前端会话，不能据此推断服务商侧持久授权。不支持权限的 Adapter 仍像以前
一样明确拒绝 `respondAuthorization`。

后台追问通过 `backend.input.requested` 发布，并始终属于当前活动 Task。Adapter 必须让
`submit` 保持等待，直到 `respondInput` 恢复同一次操作，再发出
`backend.input.resolved`。请求只携带有界问题及 `text`、`form` 或 `url` 模式；
协议原生对象与远程 ID 留在 Adapter 内。不支持交互输入的 Adapter 必须明确拒绝
`respondInput`。

## 接入 Gateway

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import { createBackendAgentHost } from 'qwen-audio-agent/backend-adapter-sdk'
import { MyBackendAdapter } from './my-backend.mjs'

const agent = createBackendAgentHost(new MyBackendAdapter())
const application = createGatewayApplication({ agent })

process.once('SIGTERM', () => application.close())
```

这个入口用于自定义 Node 启动器；现有 `AGENT_PROTOCOL` 仍选择项目内置后台，不会动态
加载任意代码。完整的非 ACP 内存示例位于
[`examples/backend-adapter`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/backend-adapter)。

## Conformance

每个第三方 Adapter 都应在自己的测试中提供新实例、两个 Task 和一个可暂停 Task：

```js
await verifyBackendAdapterConformance({
  createFixture: async ({ hold }) => ({
    backend: new MyBackendAdapter({ hold }),
    work,
    nextWork,
    started,
  }),
})
```

测试会验证幂等启动/关闭、结果边界、事件隔离、owner 隔离、重复 Task、取消和订阅清理。
协议专属能力留在 Adapter 内部；不需要模拟 ACP。
