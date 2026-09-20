# 长期记忆

长期记忆让助手在新对话中仍能了解你。默认实现使用 Markdown 文件，无需单独部署数据库。

## 记住、查看与删除

可以直接说：

- “记住，我现在住在杭州。”
- “你记住了我哪些信息？”
- “把我的住址改成苏州。”
- “忘掉那条住址记录。”

用户偏好写入 `<data-dir>/USER.md`，事实和决定写入 `<data-dir>/MEMORY.md`。新建对话不会清空这些文件。对话修改立即生效；直接编辑文件后，在下一次语音会话生效。

清单和资料文档使用各自功能，不应写进长期记忆：见[清单与提醒](../guides/notes-reminders.zh.md)、[资料库](../guides/knowledge.zh.md)。

## 自动整理

默认 Markdown Provider 可在会话结束后用文本模型补记长期信息：明确的交互偏好写入 `USER.md`，稳定事实与决定写入 `MEMORY.md`。不会修改 `ASSISTANT.md`。

默认使用 DashScope `qwen-flash` 并复用 `DASHSCOPE_API_KEY`。没有可用 Key 时自动整理关闭，明确要求的记忆工具不受影响。可关闭自动整理，或配置另一个 OpenAI 兼容文本服务：

```dotenv
QWEN_AUDIO_MEMORY_AUTO=off
```

| 配置项 | 用途 |
| --- | --- |
| `QWEN_AUDIO_MEMORY_MODEL` | 自动整理使用的文本模型 |
| `QWEN_AUDIO_MEMORY_BASE_URL` | OpenAI 兼容服务地址 |
| `QWEN_AUDIO_MEMORY_API_KEY` | 该服务的凭据 |

自动整理会额外产生模型用量。它只学习新对话，不重复学习重连恢复的历史；通过工具或客户端成功编辑记忆后，过期学习结果不会把旧内容写回来。自动整理仍可能记错，请定期查看并纠正。

## 会话回溯

默认关闭。开启后，会话结束时生成话题摘要，默认保留 90 天：

```dotenv
QWEN_AUDIO_SESSION_DIGEST=on
```

可以问“前几天我们聊过的那个项目是什么？”摘要按需检索，不是完整录音或逐字聊天记录。

摘要可记录曾经派发的工作，但不保存一份永久不变的工作状态。可用状态来自当前任务台账；记录已过期时，只能回顾聊过或做过什么，不能据此确认最新进展。

## VoiceMem 与自定义 Provider

可选 [VoiceMem](../scenarios/voicemem.zh.md) 能接管记忆、召回与会话学习。它需要单独安装，不包含在核心 npm 包中：

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_PYTHON=/absolute/path/to/python
VOICEMEM_SIDECAR=/absolute/path/to/voicemem-sidecar.py
VOICEMEM_INPUT_MODE=text
```

`text` 使用已有转写；`audio` 把按轮次截取的用户音频交给 VoiceMem。切换 Provider 不会自动迁移或删除另一套记忆，请先备份。

开发接口见 [Memory Provider](memory-provider.zh.md)。

## 隐私与诊断

相关记忆会进入语音模型上下文；自动整理还会把对话交给配置的文本服务。不要保存密码、API Key、验证码或令牌。

`<state-dir>/memory-audit.jsonl` 保存学习处理的诊断信息。分享日志前仍需检查内容；常规日志目录和轮转见[本地日志](../configuration/advanced.zh.md#本地日志)。
