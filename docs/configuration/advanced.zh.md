# 日志与诊断

## 本地日志

qwen-audio-agent 使用统一的本地结构化日志，各自保存：

- CLI 启动的 Gateway：`~/.config/qwaudio/state/logs/`。
- 桌面代管的 Gateway：`~/.config/qwaudio/state/desktop/logs/`。
- 桌面客户端：[应用数据目录](../configuration.zh.md#配置与数据目录)下的 `logs/`。
- TUI：`~/.config/qwaudio/tui/logs/`。

以下是日志文件职责；并非所有文件都在同一个目录：

```text
logs/                       # 实际根目录取决于运行方式
├── gateway.log   # Gateway、Realtime、ACP 与任务生命周期
├── desktop.log   # 桌面主进程与内嵌 Gateway 生命周期
├── cli.log       # CLI 命令生命周期
└── tui.log       # 直接启动 TUI 时的生命周期
```

日志采用一行一个 JSON 对象的 JSON Lines 格式，包含稳定的 `schema`、`time`、
`level`、`component`、`event` 和 `pid` 字段，并按需携带 `sessionId`、`turnId`、
`taskId`、`provider`、`backend`、`durationMs` 等关联信息。API Key、Token、
Authorization、Cookie、密码和 Secret 字段会在写入前脱敏；默认不记录麦克风音频、
用户转写正文、模型回复正文、任务目标或任务结果。

分析前台工具延迟时，可以按 `sessionId` 和 `turnId` 串联
`realtime.provider.speech_stopped`、`realtime.tool_call.received`、
`realtime.tool_call.result_ready` 与 `realtime.playback.started`；工具失败记为
`realtime.tool_call.failed`。其中第一个事件表示 Realtime Provider 确认的
端点，不是用户真实发声的最后一个采样；如需测量更早的“真实话音结束→端点检测”，
需使用客户端采集时间戳或受控的实时 PCM 回放。

桌面版可在“设置 → 应用程序 → 日志”中打开日志目录。默认日志级别为 `info`，单个文件
达到 10 MiB 后轮转，总共保留 5 份。可通过以下环境变量调整：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `QWEN_AUDIO_LOG_LEVEL` | `info` | `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` |
| `QWEN_AUDIO_LOG_DIR` | 实例状态目录下的 `logs` | 自定义日志目录 |
| `QWEN_AUDIO_LOG_MAX_BYTES` | `10485760` | 单个日志文件的轮转阈值 |
| `QWEN_AUDIO_LOG_MAX_FILES` | `5` | 当前文件和轮转文件的总保留数量 |
| `QWEN_AUDIO_LOG_FILE` | `1` | 设为 `0` 禁用文件日志 |
| `QWEN_AUDIO_LOG_CONSOLE` | `1` | 设为 `0` 禁用终端日志输出 |

日志仅保存在本机，不会自动上传。反馈问题前可按需检查并分享相关片段；即使系统会
自动脱敏，也应在发送前再次确认其中没有不希望公开的本机路径或业务信息。

### 只读诊断

常见连接、音频和工具问题先看[故障排查](../operations/troubleshooting.zh.md)。

```bash
qwenaudio doctor
qwenaudio doctor --json
qwenaudio doctor --turn <turnId>
```

检查配置、Gateway、语音前台与 MCP 连接、后台就绪情况及会话文件，不启动模型、后台 Agent
或麦克风，也不修改配置或修复文件。配置已填写不代表密钥额度有效；没有活动语音会话时，
会明确提示连接尚未验证。远程检查可加 `--url https://<gateway>`，凭据使用
`QWEN_AUDIO_GATEWAY_CLIENT_TOKEN`；不会用本机文件推断远程配置。

`--turn` 按已有日志的 `turnId` 整理事件时间线，只显示标识与耗时，不包含对话正文、
工具参数或结果。最多读取最近 5 个 Gateway 日志各 2 MiB、返回 500 条事件；日志被轮转、
未记录相关事件或超过限制时，时间线可能不完整。远程时间线需要在 Gateway 主机运行该命令。

会话文件与轮转日志不同，保存可恢复的历史，不会因日志轮转被删除。诊断最多检查 1,000 个
会话文件、总计 64 MiB，跳过超过 8 MiB 的文件，并标记未检查部分；异常退出留下的末尾残片
会报告为可恢复问题，在该会话下次打开写入时修复，已提交记录损坏不会被静默删除。

## 其他运行设置

网络、后台启动、音频模式与工具开关各自集中维护：

| 设置 | 文档 |
| --- | --- |
| 监听地址、Tailnet、配对与访问控制 | [远程连接](../operations/remote-access.zh.md) |
| 后台启动来源、模型、权限与工作目录 | [后台通用设置](backend.zh.md)、[各后台详细配置](../backends/configuration.zh.md) |
| 语音前台、模型与音色 | [前台配置](frontend.zh.md) |
| 终端半双工 / 全双工 | [TUI](../getting-started/tui.zh.md) |
| 搜索、资料库、记忆、提醒 | [功能指南](../guides/conversation.zh.md)、[配置总览](../configuration.zh.md#按需求配置) |

`AGENT_TIMEOUT_MS` 默认 `300000`，用于 ACP 初始化和有界控制请求，不限制正在执行的 Agent 轮次。无需为了长任务任意增大它。
