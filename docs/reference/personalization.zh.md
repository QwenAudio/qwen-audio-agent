# 个性化与记忆

可以直接通过对话设置长期称呼和交流偏好，不必修改源码：

- “以后叫我船长。”
- “以后回答简洁一些。”
- “记住，我目前住在杭州。”
- “忘掉刚才记录的住址。”

称呼与交流方式属于用户偏好；住址、项目等事实属于长期记忆。本轮临时要求只影响本轮，
不应当自动变成长久设定。默认人设可以编辑 `ASSISTANT.md`；对话中的长期修改则写入
用户偏好或记忆，不改应用默认人设。

## 默认实现

默认配置下，Gateway 使用内置 Markdown Provider。默认文件布局如下（目录可覆盖，见[配置与数据目录](../configuration.zh.md#配置与数据目录)）：

| 文件 | 说明 |
| --- | --- |
| `ASSISTANT.md` | 实例级默认人设；名称、人格、关系定位和表达风格 |
| `data/USER.md` | 当前用户的长期个性化覆盖 |
| `data/MEMORY.md` | 关于用户的长期事实与决定 |
| `<state-dir>/memory-audit.jsonl` | 自动记忆的诊断日志（补丁、跳过、失败逐条追加，仅供事后查阅） |

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

设 `QWEN_AUDIO_PREFERENCE_LEARNING=on` 后，会话结束时会观察少量用户特征，经过多会话
确认后才写入 `USER.md` 的“观察推断”段。默认关闭，会额外调用文本模型。
用户明确要求始终优先于推断；可以直接查看或删除推断段。

### 晋升门槛

确认计数与有效期见[偏好学习机制](preference-learning.zh.md#晋升门槛)。

### 四道结构性防护

证据校验与诊断规则见[偏好学习机制](preference-learning.zh.md#四道结构性防护)。

## 替换记忆实现

默认使用 Markdown 记忆，也可以选择 [VoiceMem](../scenarios/voicemem.zh.md)。
开发者接口与四层上下文边界见[Memory Provider](memory-provider.zh.md)。

## 数据与隐私

文件保存在 Gateway 主机；使用云端模型时，相关偏好与记忆仍会作为上下文提供给模型，
并非全部处理都离线完成。不要记录密码、密钥或验证码。会话结束自动整理的开关、
额外模型配置和删除方式见[长期记忆](memory.zh.md)。

## 继续阅读

- [长期记忆](memory.zh.md)：自动整理、会话回溯与可选连接器。
