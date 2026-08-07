# 用户档案与记忆

用户数据保存在配置目录下（CLI 为 `~/.config/qwaudio/`）：

| 文件 | 说明 |
| --- | --- |
| `USER.md` | 称呼、所在地、偏好和常用项目 |
| `frontend-memory.json` | 跨会话长期记住的信息（明确要求记住的，以及会话后自动沉淀的） |
| `memory-audit.jsonl` | 自动记忆的审计日志（写入、跳过、失败逐条追加，仅供事后查阅） |
| `tasks.json` | 后台任务结果和待通知状态 |
| `state.env` | 本地身份密钥（首次启动自动生成，仅当前用户可读写） |
| `logs/` | 经过凭据脱敏并自动轮转的本地运行日志 |

这些文件只保存在本机，不会写入源码仓库，文件权限为仅当前用户可读写。

## USER.md

可以直接编辑 `USER.md` 手写内容，也可以在对话中要求助理记住或忘记信息。
程序只会改动文件内带标记的托管区域，其他手写内容原样保留；修改后下一轮对话
即可生效。如需把档案放在其他位置，可设置
`QWEN_AUDIO_AGENT_USER_PROFILE_PATH`。

请勿在其中保存密码、API Key、验证码或令牌。

## 长期记忆

`frontend-memory.json` 保存跨会话记住的个人事实、喜好和约定，来源有两种：

- **明确要求**：对话中说“记住、改成、不再”等，助理会用对应记忆操作更新或
  替换旧记录。
- **自动沉淀**：会话结束后，一个轻量文本模型会从对话中提取稳定的个人事实
  （如喜好、习惯、长期计划）静默保存，不需要说“记住”。自动沉淀默认使用
  DashScope 的 `qwen-flash` 模型（复用 `DASHSCOPE_API_KEY`）；没有可用 API Key
  时自动关闭，明确要求的记忆不受影响。设置 `QWEN_AUDIO_MEMORY_AUTO=off`
  可全局关闭；`QWEN_AUDIO_MEMORY_MODEL`、`QWEN_AUDIO_MEMORY_BASE_URL`、
  `QWEN_AUDIO_MEMORY_API_KEY` 可指向任意 OpenAI 兼容端点（含本地 Ollama）。

自动沉淀只会写入普通长期记忆，不会创建或修改长期约定与用户档案；密码、
密钥等敏感内容会被双重过滤拦截。每次自动写入都记录在 `memory-audit.jsonl`
中可供查阅。觉得某条记忆不对，直接在对话中说“那条记错了”或“忘掉它”即可。
记忆容量与保留时间使用内置默认值，详见[配置说明](../configuration.zh.md)。

## 日志

日志采用 JSON Lines 格式，API Key、Token、Authorization、Cookie、密码和
Secret 字段会在写入前脱敏，默认不记录麦克风音频、用户转写正文、模型回复正文
或任务结果。桌面版可在“设置 → 应用 → 日志”中打开日志目录。详见
[配置说明](../configuration.zh.md#本地日志)。
