# 个性化与记忆

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

## 默认实现

没有注入 `MemoryProvider` 时，Gateway 使用内置 Markdown Provider。相关数据保存在配置目录下（CLI 为
`~/.config/qwaudio/`）：

| 文件 | 说明 |
| --- | --- |
| `ASSISTANT.md` | 实例级默认人设；名称、人格、关系定位和表达风格 |
| `USER.md` | 当前用户的长期个性化覆盖 |
| `MEMORY.md` | 关于用户的长期事实与决定 |
| `memory-audit.jsonl` | 自动记忆的诊断日志（补丁、跳过、失败逐条追加，仅供事后查阅） |

这些文件只保存在本机，不会写入源码仓库。`USER.md` 与 `MEMORY.md` 只是默认 Provider
的物理实现，不是其他 Provider 必须采用的格式。

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

## 偏好自更新（仅默认 Provider，默认关闭）

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

## 替换记忆实现

宿主应用可以注入带版本的 `MemoryProvider`，完整替换 `user` 与 `memory` 两层。Provider
可以使用 Markdown、数据库、远程服务或语义记忆引擎。它负责存储与检索；声明
`sessionObservation` 后还会接管会话结束后的自动学习，内置抽取器和偏好学习器会停用。

这个扩展边界刻意不包含 `PROMPT.md` 和 `ASSISTANT.md`，因此无论使用哪套记忆系统，
核心行为和实例级默认人设都保持稳定。Realtime Agent 仍使用同一个 `memory` 工具以及
`user` / `memory` 两种逻辑作用域。

Provider 接口见[长期记忆](memory.zh.md)，完整替换方式见可运行的
[VoiceMem 示例](../scenarios/voicemem-memory.zh.md)。

## 继续阅读

- [长期记忆](memory.zh.md) —— 默认 Markdown 实现、`memory` 工具、会话摘要与
  可替换 Provider 接口
