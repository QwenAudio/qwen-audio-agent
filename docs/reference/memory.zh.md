# 长期记忆

Gateway 通过两个逻辑文档提供记忆能力：`user` 保存用户明确设定的长期个性化，
`memory` 保存长期事实与决定。默认 Provider 将它们存为 `USER.md` 与 `MEMORY.md`；
外部 Provider 可以采用其他物理模型，但必须保持相同的公开语义。四层上下文和冲突顺序见
[个性化与记忆](personalization.zh.md)。

## 默认 Markdown Provider

`MEMORY.md` 使用普通 Markdown 保存关于用户的长期事实与决定，例如所在地、习惯、兴趣、
关系、项目、目标和计划。它只帮助理解和回答，不直接支配行为。内容来源有两种：

- **明确要求**：对话中说“记住、改成、不再”等，助手会生成精确 Markdown 修改；
  一句话中的多项信息会在同一轮逐项处理，并只生成一次最终回应。
- **自动整理**：会话结束后，一个轻量文本模型会查漏补缺，把用户明确提出的长期交互
  指令写入 `USER.md`，把稳定事实与决定写入 `MEMORY.md`。自动整理默认使用
  DashScope 的 `qwen-flash` 模型（复用 `DASHSCOPE_API_KEY`）；没有可用 API Key
  时自动关闭，明确要求的记忆不受影响。设置 `QWEN_AUDIO_MEMORY_AUTO=off`
  可全局关闭；`QWEN_AUDIO_MEMORY_MODEL`、`QWEN_AUDIO_MEMORY_BASE_URL`、
  `QWEN_AUDIO_MEMORY_API_KEY` 可指向任意 OpenAI 兼容端点（含本地 Ollama）。

Realtime 与自动整理都通过同一个记忆服务提交受限 Markdown 变更，不能直接写文件。
自动整理可以补记用户明确说出的称呼或回复偏好，但不会推测这些设定，也永远不能修改
`ASSISTANT.md`。密码、
密钥等敏感内容会被双重过滤拦截。`memory-audit.jsonl` 只记录补丁是否执行、版本和
错误等诊断信息，不保存完整记忆正文。觉得内容不对，直接在对话中说“那条记错了”
或“忘掉它”即可；助手会修改或删除对应 Markdown 原文。

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

## 会话摘要与回溯（默认关闭）

设 `QWEN_AUDIO_SESSION_DIGEST=on` 后，会话结束时记下这一场的话题与一句不超过 50 字的
要点，保留 90 天，供 `recall` 工具回答「前几天我们聊的那个」。

摘要**不注入** `instructions`：它每场都在变，注入会让 prompt 前缀每场都变、前缀缓存
失效。所以它是一个按需调用的工具，而不是上下文的一部分。

`recall` 只回答「以前聊过什么、派过什么活」。个人事实与偏好由 `memory` 工具读取；
用户提供的参考资料走 `knowledge` 工具（见[知识检索 Provider](./knowledge.zh.md)）。

摘要里只冻结派过的活的目标，**不存状态**：状态是活的，存进摘要过几天那个值就是错的
且不会报错。状态一律在检索时从任务台账实时读；台账终态只保留 3 天，更早的活查不到
记录，此时只回答「派过这件事」而不给状态。

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
- 声明 `sessionObservation` 的 Provider 实现 `observe()`，接收已完成的会话交流；可选的
  `flush()` 完成 Provider 自己的会话边界整理。
- 可选的 `health()` 和 `close()` 分别接入健康诊断与生命周期清理。

能力必须显式声明。开启 `sessionObservation` 后，内置 Markdown 自动整理器与偏好学习器
会自动停用，同一段对话不会被两套系统重复学习。协议 v1 Provider 仍然兼容，继续使用
原有 `list()` / `apply()` 行为。此时 Provider 也必须自行负责所接收对话的保留期限、
敏感信息过滤、删除策略和租户隔离。

Realtime、自动整理器和工具处理器只依赖 `FrontendMemoryRuntime`，不会访问供应商 SDK、
数据库或 Markdown 文件。未注入 Provider 时继续使用现有 Markdown 实现，现有配置和数据
无需迁移。第三方 Adapter 自行负责远程认证、租户映射、缓存刷新和底层记录到 `user`、
`memory` 两种公开上下文语义的转换。完整替换方式见
[VoiceMem 示例](../scenarios/voicemem-memory.zh.md)：它通过 Python Sidecar 接入
VoiceMem，核心代码不感知其内部模型与索引。

## 日志

日志采用 JSON Lines 格式，API Key、Token、Authorization、Cookie、密码和
Secret 字段会在写入前脱敏，默认不记录麦克风音频、用户转写正文、模型回复正文
或任务结果。桌面版可在“设置 → 应用 → 日志”中打开日志目录。详见
[配置说明](../configuration/advanced.zh.md#本地日志)。
