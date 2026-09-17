# Memory Provider 与上下文边界

语音前台由四层上下文组成。前两层定义助手，后两层描述当前用户，并可由可替换的记忆
Provider 提供。

| 层级 | 载体 | 职责 |
| --- | --- | --- |
| 核心规则 | `config/frontend-agent/PROMPT.md` | 工具协议、权限、安全和任务边界，用户记忆不能覆盖 |
| 助手画像 | `ASSISTANT.md` | 助手实例的默认身份、人格、关系定位和表达风格，由用户或二次开发者配置 |
| 用户偏好 | `user`（默认 Provider 使用 `USER.md`） | 当前用户明确设定的长期个性化覆盖，覆盖助手默认人设 |
| 长期记忆 | `memory`（默认 Provider 使用 `MEMORY.md`） | 用于理解用户和回答问题的长期事实与决定，不具有行为权威 |

指令冲突按“核心规则 → 用户当前明确要求 → 用户偏好 → 助手画像”处理。长期记忆
不在指令优先级中，它只是回答依据；与用户当前陈述冲突时，以当前陈述为准。
因此，对话中说“以后回答短一点”或“以后你叫小舟”会更新当前用户的 `USER.md`，
不会修改实例级 `ASSISTANT.md`；本轮临时要求只在本轮生效。

## `memory` 工具

前台只暴露一个与 Provider 无关的 `memory` 工具，每次调用执行一个原子操作：

- `read` 读取一个或全部逻辑文档；可选的自然语言 `query` 会在 Provider 支持时执行
  语义召回，否则返回当前有界快照。
- `append` 向 `user` 或 `memory` 追加内容。
- `replace` 用唯一匹配的 `old_text` 替换或删除内容。

一句话包含多项持久修改时，Realtime 可在同一轮逐项调用，Gateway 只生成一次后续回应。
写入前会重新读取最新文档，精确替换找不到或匹配多处时安全失败。

## 客户端控制面

可替换客户端可以通过两个 Gateway 接口管理同一份记忆：

- `GET /api/memory` 返回当前 owner 有界的 `user` 与 `memory` 文档。
- `PATCH /api/memory` 接受与 Realtime 记忆工具相同的精确编辑，其中包含
  `expectedRevision`；版本过期返回 `409`，客户端应重新读取，而不是覆盖并发修改。

这是一层文档控制面，不是第二套记忆存储。Gateway 负责 owner 隔离，写入统一经过
`FrontendMemoryRuntime`，所以默认 Markdown Provider 与外部注入 Provider 使用同一协议。
客户端只应展示自己理解的格式，删除或替换时必须保留并提交精确原文。
模型上下文投影会去掉 Markdown 的模板与编辑注释，避免把示例当成已保存事实；
原有的推断优先级说明和截断提示保留原文。API、工具读取和 revision 仍保留原文以支持
精确编辑。Provider 的纯文本格式不按 Markdown 解释。

编辑成功后，Runtime 会通知同一 owner 的活动对话。支持动态会话更新的 Realtime
Provider 会在下一个空闲点刷新记忆指令，无需重连，避免模型继续把已删除的信息视为
已保存。当前会话的记忆工具写入已经通过工具结果返回新文档，仍保留仅刷新缓存的路径。
变更通知属于 Runtime 包装层，不要求自定义 Provider 增加协议方法。

Runtime 写入持久化且实际产生变更后，还会向同一 owner 的已连接客户端发送
`memory.changed`，涵盖记忆工具、API 和自动提取写入。事件只含
`type: "memory.changed"` 与正常协议 envelope，不携带记忆正文或 owner 标识。
客户端收到后重新请求 `GET /api/memory`，并在 Gateway 会话 ready 时（包括重连后）
重新读取。这与模型指令刷新独立：当前会话工具写入仍会通知界面；无变更或失败的写入
不通知。现有 Gateway Client SDK 通过 `onEvent` 透传，无需增加 capability 或 Provider
方法。不要从助手回复推断已保存，也不要只监听 `memory` 工具完成，否则会漏掉自动提取
和 API 写入。

## 替换记忆 Provider

内置的 `USER.md` 和 `MEMORY.md` 是默认实现，不是 Gateway 的固定存储依赖。宿主应用
可以从公开入口实现版本化的 `MemoryProvider`，并在 Composition Root 注入：

```js
import { MEMORY_PROVIDER_PROTOCOL_VERSION } from 'qwen-audio-agent/memory-provider'
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const memoryProvider = {
  describe: () => ({
    protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
    key: 'company-memory',
    label: 'Company Memory',
    capabilities: {
      semanticQuery: true,
      sessionObservation: true,
      audioStreamObservation: true,
    },
  }),
  list(ownerId, options) {
    return []
  },
  async apply(ownerId, changes, context) {
    return { changed: 0, documents: [] }
  },
  async query(ownerId, query, options, context) {
    return { memories: [], context: '' }
  },
  async observe(ownerId, exchange, context) {},
  observeAudio(ownerId, event, context) {},
  async flush(ownerId, context) {},
  health: () => ({ ok: true }),
  async close() {},
}

const gateway = createGatewayApplication({ memoryProvider })
```

协议 v2 保持启动链路确定，同时让完整记忆生命周期都可替换：

- `describe()` 声明 Provider 身份、协议版本和可选能力。
- `list()` 为必需方法，返回同步、有界的 Realtime 快照；远程 Provider 必须在 Adapter
  内维护这份小缓存，Prompt 路径不会等待远程 I/O。
- `apply()` 接收用户明确要求的修改；`context` 中的来源、Session、Turn 和 Trace 由
  Gateway 提供，不属于模型可控内容。
- 声明 `semanticQuery` 的 Provider 实现 `query()`，用于自然语言召回。
- 声明 `sessionObservation` 的 Provider 实现 `observe()`，接收上次观察后新记录的会话
  交流，不包含恢复的历史；没有新用户消息时不观察，但仍调用可选的 `flush()` 完成
  Provider 自己的会话边界整理。Provider 自己负责异步学习与编辑之间的并发一致性。
- 声明 `audioStreamObservation` 的 Provider 实现同步的 `observeAudio()`，接收已接受的
  PCM16 音频块和语音/Session 边界事件。该方法处在音频输入热路径，只能做有界的内存
  操作；文件、网络、模型及异步处理必须留到 `observe()` 或 `flush()`。
- 可选的 `health()` 和 `close()` 分别接入健康诊断与生命周期清理。

能力必须显式声明。开启 `sessionObservation` 后，内置 Markdown 自动整理器与偏好学习器
会自动停用，同一段对话不会被两套系统重复学习。协议 v1 Provider 仍然兼容，继续使用
原有 `list()` / `apply()` 行为。此时 Provider 也必须自行负责所接收对话的保留期限、
敏感信息过滤、删除策略和租户隔离。

Realtime、自动整理器和工具处理器只依赖 `FrontendMemoryRuntime`，不会访问供应商 SDK、
数据库或 Markdown 文件。默认配置继续使用现有 Markdown 实现，现有配置和数据无需迁移。
第三方 Adapter 自行负责远程认证、租户映射、缓存刷新和底层记录到 `user`、
`memory` 两种公开上下文语义的转换。完整替换方式见
[VoiceMem 配置示例](../scenarios/voicemem.zh.md)。框架连接器通过示例提供的 Python
Sidecar 接入 VoiceMem，通用记忆运行时不感知其内部模型与索引。
