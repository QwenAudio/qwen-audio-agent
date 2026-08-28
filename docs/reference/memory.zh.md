# 助手画像、用户偏好与记忆

前台上下文分成四层，职责互不重叠：

| 层级 | 载体 | 职责 |
| --- | --- | --- |
| 核心规则 | `config/frontend-agent/PROMPT.md` | 工具协议、权限、安全和任务边界，用户记忆不能覆盖 |
| 助手画像 | `ASSISTANT.md` | 助手实例的默认身份、人格、关系定位和表达风格，由用户或二次开发者配置 |
| 用户偏好 | `USER.md` / `user` | 当前用户明确设定的长期个性化覆盖，覆盖助手默认人设 |
| 长期记忆 | `MEMORY.md` / `memory` | 用于理解用户和回答问题的长期事实与决定，不具有行为权威 |

指令冲突按“核心规则 → 用户当前明确要求 → 用户偏好 → 助手画像”处理。长期记忆
不在指令优先级中，它只是回答依据；与用户当前陈述冲突时，以当前陈述为准。
因此，对话中说“以后回答短一点”或“以后你叫小舟”会更新当前用户的 `USER.md`，
不会修改实例级 `ASSISTANT.md`；本轮临时要求只在本轮生效。

用户数据保存在配置目录下（CLI 为 `~/.config/qwaudio/`）：

| 文件 | 说明 |
| --- | --- |
| `ASSISTANT.md` | 实例级默认人设；名称、人格、关系定位和表达风格 |
| `USER.md` | 当前用户的长期个性化覆盖 |
| `MEMORY.md` | 关于用户的长期事实与决定 |
| `memory-audit.jsonl` | 自动记忆的诊断日志（补丁、跳过、失败逐条追加，仅供事后查阅） |
| `tasks.json` | 后台任务结果和待通知状态 |
| `state.env` | 本地身份密钥（首次启动自动生成，仅当前用户可读写） |
| `logs/` | 经过凭据脱敏并自动轮转的本地运行日志 |

这些文件只保存在本机，不会写入源码仓库，文件权限为仅当前用户可读写。

## 助手画像

首次启动会从随包模板 `config/frontend-agent/ASSISTANT.md` 创建本地
`ASSISTANT.md`，之后升级不会覆盖。直接编辑本地文件即可更改整个助手实例的默认名称、
人格、关系定位和表达风格，下一次建立语音会话时生效；也可用
`QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH` 指向其他文件。

`ASSISTANT.md` 不是对话记忆，也不是运行规则。助手不会通过 `memory` 工具修改它；
写在其中的工具、权限、安全、记忆、任务路由或能力声明不会覆盖 `PROMPT.md`。

## 用户偏好

`USER.md` 是当前用户对默认人设的长期个性化覆盖，不是第二份助手人设，也不是通用事实
仓库。它可以保存助手如何称呼用户、用户如何称呼助手，以及用户明确要求长期采用的语言、
回复风格和默认做法。只有用户明确设定或纠正时才会修改；会话后自动整理可以补记这类
明确指令，但不能推测用户偏好。

判断标准不是描述对象，而是作用域：“助手默认叫千问 Audio”属于 `ASSISTANT.md`；当前
用户在对话中说“以后你叫小舟”，则“小舟”是当前用户的覆盖，属于 `USER.md`。同理，
“默认继续 A 项目”属于 `USER.md`，而“A 项目使用 React”只是事实，属于 `MEMORY.md`。
文件是普通 Markdown，工具写入立即生效，直接编辑则在下一次语音会话生效。如需放在
其他位置，可设置
`QWEN_AUDIO_AGENT_USER_MODEL_PATH`（旧名称
`QWEN_AUDIO_AGENT_USER_PROFILE_PATH` 仍可读取）。

请勿在其中保存密码、API Key、验证码或令牌。

旧版 `frontend-memory.json` 中的 `profile`、`rules` 和 `user` 内容会在首次启动时
迁移到 `USER.md`。

## 长期记忆

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

前台只暴露一个 `memory` 工具，每次调用执行一个原子操作：`read` 读取文档，
`append` 追加 Markdown，`replace` 用文档中唯一匹配的 `old_text` 替换或删除内容。
一句话包含多项持久修改时，Realtime 可在同一轮逐项调用，Gateway 只生成一次
后续回应。写入前会重新读取最新文档，精确替换找不到或匹配多处时安全失败。

## 偏好自更新（默认关闭）

设 `QWEN_AUDIO_PREFERENCE_LEARNING=on` 后，会话结束时会从这一场对话里观察用户画像，
跨会话攒够确认再写进 `USER.md`。默认关闭，因为它每场会话多一次模型调用。

只观察四个字段，取值空间刻意收窄：

| 字段 | 说明 |
| --- | --- |
| `occupation` | 职业 |
| `special_skills` | 擅长的技术或领域，最多 6 项 |
| `response_length` | 回答长短，只能是 `brief`、`normal`、`detailed` 之一 |
| `response_style` | 回答风格 |

写入位置是 `USER.md` 的 `## 观察推断` 段，与 `## 用户明确要求` **物理分开**。两段冲突
时明说恒优先。这样划分是为了避免推断内容污染用户自己写下的指令 —— 用户能看到哪些是
他说过的、哪些是系统猜的，也能直接编辑或删掉后者。

### 晋升门槛

一条观察要同时满足两个条件才写进文档：`confirm ≥ 2` 且来自 **≥ 2 个不同会话**。
90 天内没有新确认则 `confirm` 归零。

### 四道结构性防护

模型有时会给出真实的引用、但从引用到结论的推理不成立。这类错误重复采样挡不住 ——
用户每场都说同一句话，模型每次同样误推，计数照样涨到门槛。所以判据放在入池那一刻：

| 判据 | 挡什么 |
| --- | --- |
| `quote_not_from_user` | 引用必须逐字出现在用户轮，挡编造证据、把助手发言当用户偏好、以及自我强化 |
| `value_not_anchored` | 结论的字面成分要能在引用里找到落点 |
| `value_parrots_quote` | 值与引用完全相同 —— 那是复读，不是提取特征 |
| `quote_not_about_interaction` | 交互偏好字段的引用必须指向助手，挡「把内容该多长当成回话该多长」 |

诊断记录写进 `memory-audit.jsonl`，可以事后查某条为什么没被收下。

## 会话摘要与回溯（默认关闭）

设 `QWEN_AUDIO_SESSION_DIGEST=on` 后，会话结束时记下这一场的话题与一句不超过 50 字的
要点，保留 90 天，供 `recall` 工具回答「前几天我们聊的那个」。

摘要**不注入** `instructions`：它每场都在变，注入会让 prompt 前缀每场都变、前缀缓存
失效。所以它是一个按需调用的工具，而不是上下文的一部分。

`recall` 只回答「以前聊过什么、派过什么活」。用户自己的资料走 `knowledge` 工具
（见 [知识检索 Provider](./knowledge.zh.md)）。

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
  }),
  list(ownerId, options) {
    return []
  },
  async apply(ownerId, changes, context) {
    return { changed: 0, documents: [] }
  },
  health: () => ({ ok: true }),
  async close() {},
}

const gateway = createGatewayApplication({ memoryProvider })
```

`list()` 必须返回同步、有界的 Realtime 上下文快照；远程 Provider 应在 Adapter 内维护
本地缓存。`apply()` 可以异步，`context` 中的来源、Session、Turn 和 Trace 由 Gateway
提供，不属于模型可控的修改内容。Provider 返回的文档会统一限制长度、规范 scope，并
丢弃重复或无效文档。

Realtime、自动整理器和工具处理器只依赖 `FrontendMemoryRuntime`，不会访问供应商 SDK、
数据库或 Markdown 文件。未注入 Provider 时继续使用现有 Markdown 实现，现有配置和数据
无需迁移。第三方 Adapter 自行负责远程认证、租户映射、缓存刷新和底层记录到 `user`、
`memory` 两种公开文档语义的转换。

## 日志

日志采用 JSON Lines 格式，API Key、Token、Authorization、Cookie、密码和
Secret 字段会在写入前脱敏，默认不记录麦克风音频、用户转写正文、模型回复正文
或任务结果。桌面版可在“设置 → 应用 → 日志”中打开日志目录。详见
[配置说明](../configuration.zh.md#本地日志)。
