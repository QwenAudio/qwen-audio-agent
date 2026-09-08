# 高级设置

## 远程访问安全

连接方式、Tailnet、HTTPS 反向代理与配对命令已集中在[远程连接与配对](../operations/remote-access.zh.md)。

## Gateway 运行方式

终端运行、后台常驻、桌面内置 Gateway 与重启方式见[Gateway 运行与常驻](../operations/gateway.zh.md)。

## 本地日志

qwen-audio-agent 使用统一的本地结构化日志。CLI 默认目录为
`~/.config/qwaudio/logs/`；桌面版默认在其[应用数据目录](../configuration.zh.md#配置与数据目录)
的 `logs/` 下，例如 macOS 的 `~/Library/Application Support/Qwen Audio Agent/logs/`。

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

桌面版可在“设置 → 应用 → 日志”中打开日志目录。默认日志级别为 `info`，单个文件
达到 10 MiB 后轮转，总共保留 5 份。可通过以下环境变量调整：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `QWEN_AUDIO_LOG_LEVEL` | `info` | `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` |
| `QWEN_AUDIO_LOG_DIR` | 用户配置目录下的 `logs` | 自定义日志目录 |
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

TUI、WebUI 和桌面版只连接 Gateway，不直接连接、启动或停止任何后台 Agent。
桌面设置中的核心配置会保存到用户配置文件，在下次启动 Gateway 时生效；
Gateway 地址会立即验证并切换。

OpenCode 和 OpenClaw 使用一致的用户环境优先顺序：

1. `OPENCODE_BIN` / `OPENCLAW_BIN` 明确指定的可执行文件。
2. `OPENCODE_SOURCE_DIR` / `OPENCLAW_SOURCE_DIR` 明确指定的源码目录。
3. PATH 中用户已经安装的 `opencode` / `openclaw`。
4. 找不到兼容安装时，通过 `npx` 自动使用当前版本验证过的固定 npm 包。

源码目录只在用户明确配置后使用，不再推测相邻项目目录。需要强制选择某种启动
方式时可配置：

```dotenv
# auto（默认）、binary、source、installed 或 package
OPENCODE_RUNTIME=auto
OPENCLAW_RUNTIME=auto
```

需要临时验证其他固定包版本或内部镜像时，可以显式覆盖完整 package specifier：

```dotenv
OPENCODE_PACKAGE=opencode-ai@1.18.5
OPENCLAW_PACKAGE=openclaw@2026.6.33
```

OpenCode ACP 接入当前要求 OpenCode `1.18.0` 或更高版本。`auto` 模式发现更旧
版本时会使用固定兼容包，不修改用户安装；显式设置 `installed` 时直接报错。
最低版本可由 `OPENCODE_MIN_VERSION` 覆盖，用于验证其他兼容版本。

qwen-audio-agent 启动的 OpenCode 默认继承用户原有的全局配置（通常是
`~/.config/opencode/opencode.json`），因此已经安装的 MCP、Skill、权限、模型和
插件可以继续使用。协调规则和可用的 Session 工具由 Gateway 通过后台接入层提供，不会额外安装或覆盖 OpenCode Agent。

如果用户配置或第三方插件与 qwen-audio-agent 冲突，可以临时启用隔离模式排查：

```dotenv
QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG=true
```

也可以通过 `QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME` 指定另一套 OpenCode 用户
配置目录。隔离后，原全局配置中的 MCP 和插件不会自动加载。


## 高级设置

以下设置都有稳定默认值，普通用户不需要写入配置文件：

| 设置 | 默认值 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3101` |
| `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS` | 空；只允许 loopback |
| `QWEN_AUDIO_GATEWAY_TAILNET` | 空；设为 `1` 后使用系统 Tailscale Serve |
| `QWEN_AUDIO_GATEWAY_PUBLIC_URL` | 空；用户自行维护的 HTTPS Origin |
| `QWEN_AUDIO_TAILSCALE_BINARY` | 自动发现；系统 Tailscale CLI 的可选绝对路径 |
| `OPENCODE_WORKSPACE` | 共享数据目录下的 `workspace` |
| `QODER_WORKSPACE` | 共享数据目录下的 `workspace` |
| `QWEN_AUDIO_AGENT_BACKEND_MODEL` | 空；显式值仅通过 ACP 标准覆盖 Session；OpenCode/OpenClaw 托管初始化除外 |
| `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` | `native` |
| `QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` | 空；仅供通用 ACP 显式传递的环境变量名，逗号分隔 |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` |
| `QWEN_AUDIO_REALTIME_PROVIDER` | `dashscope` |
| `QWEN_AUDIO_WEB_SEARCH_PROVIDER` | `so360`；可选 `bailian`、`bing`、`mcp` 或 `none` |
| `QWEN_AUDIO_WEB_SEARCH_MCP_URL` | 空；`mcp` Provider 使用的自定义 Streamable HTTP 地址 |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN` | 显式选择 `bailian` 时复用 `DASHSCOPE_API_KEY`；自定义地址默认空 |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOOL` | `bailian` 为 `bailian_web_search`，其他地址为 `web_search` |
| `QWEN_AUDIO_SCHEDULE_TOOL_ENABLED` | `true`；设为 `false` 时隐藏 `schedule_reminder` |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | `true`；设为 `false` 时不向前台 Agent 提供 `web_search` 和 `fetch_url` |
| `QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED` | `true`；设为 `false` 时隐藏 `knowledge` |
| `QWEN_AUDIO_NOTES_TOOL_ENABLED` | `true`；设为 `false` 时隐藏 `notes` |
| `QWEN_AUDIO_RECALL_TOOL_ENABLED` | `true`；设为 `false` 时隐藏 `recall` |
| `QWEN_AUDIO_FRONTEND_PROFILE` | 空；轻量 Frontend Profile JSON 文件路径 |
| `QWEN_AUDIO_FRONTEND_MCP_CONFIG` | 空；前台 MCP 版本化 JSON 文件的绝对路径 |
| `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` | 空；前台 OpenAPI 版本化 JSON 配置文件的绝对路径 |
| `QWEN_AUDIO_REALTIME_VOICE` | 空；Audio 模型族的可选覆盖，未设置时运行时使用 `longanqian` |
| `QWEN_OMNI_REALTIME_VOICE` | 空；Omni 模型族的可选覆盖，未设置时运行时使用 `Ethan` |
| `SPEECH_TO_SPEECH_REALTIME_URL` | `ws://127.0.0.1:8765/v1/realtime` |
| `SPEECH_TO_SPEECH_AUTH_TOKEN` | 空；仅用于带 Bearer 认证的代理 |
| `MINICPM_O_REALTIME_URL` | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |
| `MINICPM_O_AUTH_TOKEN` | 空；仅用于带 Bearer 认证的代理 |
| `QWEN_AUDIO_AGENT_IDENTITY_MODE` | `personal` |
| `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE` | `half` |
| `AGENT_TIMEOUT_MS` | `300000`；ACP 连接初始化与有界控制请求的超时，不限制正在执行的 Agent 轮次 |

macOS TUI 的 CoreAudio 辅助程序默认编译到
`~/Library/Caches/qwaudio/tui/macos-voice-io`，无需额外配置。它在播报期间
持续收音，只支持语音打断。
Linux 和 Windows 的 minimal TUI 通过随包提供的 Python 音频桥接使用
`sounddevice`/PortAudio 半双工；播放回复时麦克风会暂停，通过 `/interrupt`
手动打断，播放结束或手动打断后恢复。

Linux 和 Windows 可通过 `qwenaudio tui --audio-mode full` 或设置
`QWEN_AUDIO_AGENT_TUI_AUDIO_MODE=full` 明确开启 PortAudio 全双工。此模式没有
回声消除，只支持直接说话打断；推荐佩戴耳机，避免扬声器回声触发误识别或误打断。
macOS 始终使用 CoreAudio AEC 全双工，不受该选项影响。

如果 PortAudio 全双工持续报告输入溢出、输出欠载或设备错误，请退出 TUI 并改用
`qwenaudio tui --audio-mode half`。不同 Linux/Windows 声卡和蓝牙耳机对同时使用
不同采样率的输入、输出流支持程度不同，半双工是兼容性兜底。

任务状态、通知重试、记忆容量与保留时间等运行参数同样使用内置默认值。只有明确
进行容量规划或故障诊断时才建议覆盖。
