# 配置

正式安装后，qwen-audio-agent 从用户配置文件读取设置：

```text
~/.config/qwaudio/config.env
```

设置 `QWAUDIO_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 可以更改配置目录。开发仓库中的
`.env.local` 和 `.env` 仍然支持，并优先于用户配置文件。

配置优先级固定为：

```text
CLI 参数 > 进程环境变量 > .env.local > .env > 用户配置文件 > 内置默认值
```

运行下面的命令可以显示当前用户配置文件的准确位置：

```bash
qwenaudio config
```

## 后台 Setup 检查

配置后台 Agent 后，可运行统一的只读检查：

```bash
qwenaudio setup
```

它会检查后台可执行文件、ACP 接入方式和必要的 Adapter，并明确显示当前选择。
检查命令本身不会安装或下载后台 Agent，不会触发登录，也不会输出或验证凭据、修改模型
配置。它会提示 OpenCode/OpenClaw 是否能在正式启动时自动下载和配置；其他后台
的认证状态由 Agent 自己管理。

只检查指定后台或获取机器可读结果：

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

JSON 输出与 CLI 使用同一个共享检测模块，可供桌面版和其他工具直接复用。

## 最小配置

最小配置只需要填写实时语音凭据：

```dotenv
DASHSCOPE_API_KEY=your-key
```

需要执行后台任务时，再选择后台 Agent（以 OpenClaw 为例）：

```dotenv
AGENT_PROTOCOL=openclaw
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

OpenCode 和 OpenClaw 在以上配置下可以自动下载兼容版本并配置百炼模型，实现
一键启动。若未指定后台模型，则优先使用用户已经安装和配置的 Agent，不覆盖其
模型、Provider、工具、MCP、Skill 和认证。其他后台暂时需要用户自行安装配置。

这是 qwen-audio-agent 唯一的后台模型配置入口。Gateway 会把该值映射为所选后台
使用的模型标识；模型 ID 仍由各 Agent 定义，并不由 ACP 统一命名。后台自身的
原生模型环境变量可以继续由后台读取，但 Gateway 不会把它们解释为模型覆盖请求。

未指定模型时，Gateway 不传模型，也不猜测默认值：新建 Session 的模型完全由
后台 Agent 根据用户配置选择，恢复 Session 则保留其原有模型。历史 Session
使用的模型可能与用户当前默认模型不同，这是后台 Agent 的 Session 语义，
Gateway 不会擅自重置。

显式模型会应用于协调 Session、新建项目 Session 和恢复的项目 Session。Gateway
从 ACP `configOptions` 中按 `category: model` 发现模型选项，并通过
`session/set_config_option` 设置；如果 Agent 没有提供模型配置、目标模型不在
可选清单中、调用失败或返回结果无法确认生效，当前请求会明确失败，不会静默换用
其他模型。未设置 `QWEN_AUDIO_AGENT_BACKEND_MODEL` 时完全不调用模型设置接口。

本地身份密钥由程序首次启动时自动生成，保存在同一配置目录的 `state.env`，
文件权限为仅当前用户可读写。

同一目录还会自动创建 `USER.md`，用于保存稳定用户档案。程序只会改动文件内带标记
的托管区域，其他手写内容会原样保留；修改后下一轮对话即可生效。请勿在其中保存
密码、API Key、验证码或令牌。
如需把档案放在其他位置，可设置：

```dotenv
QWEN_AUDIO_AGENT_USER_PROFILE_PATH=/absolute/path/to/USER.md
```

本机 `USER.md` 只在默认的 `personal` 身份模式下注入上下文；多用户 `browser`
模式不会共享这份档案。

同一用户目录还保存：

```text
frontend-memory.json  # 用户明确要求跨会话记住的长期信息
tasks.json            # 后台任务、结果和待播报通知的恢复状态
```

这些文件和 `USER.md`、`state.env` 一样只允许当前用户读写，不会写入源码仓库。
旧版仓库 `runtime/` 目录中的对应文件会在首次启动时自动迁移。高级用户仍可通过
`QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH` 和 `QWEN_AUDIO_AGENT_TASK_STATE_PATH`
覆盖位置。

## 选择后台

`AGENT_PROTOCOL` 没有默认值，也是可选配置。留空时 Gateway 仅提供前台实时语音
聊天；需要后台执行的请求会返回明确错误，不会创建任务或猜测执行结果。
也可以使用 `qwenaudio --backend none` 显式启动仅前台模式。

OpenClaw 默认地址为 `http://127.0.0.1:18789`：

```dotenv
AGENT_PROTOCOL=openclaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
```

默认优先启动用户环境中的 `openclaw`。同时提供 `DASHSCOPE_API_KEY` 和
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，会为 qwen-audio-agent 进程生成独立的
百炼配置和状态目录，不修改用户原生配置。未指定后台模型时则继承用户的原生
配置、模型和认证，但不会在独立实例中启用钉钉等外部消息渠道。若原配置启用了
Gateway Token，会自动读取并用于本地 ACP 连接；也可以通过
`OPENCLAW_GATEWAY_TOKEN` 覆盖，或设置 `OPENCLAW_CONFIG_PATH` 明确指定另一份
OpenClaw 配置。

OpenCode：Gateway 通过 `opencode acp` 与它交互，并管理用于打开原生 Session
界面的本地服务。没有兼容安装时会自动使用固定 npm 包，用户不需要另行安装或
启动服务：

```dotenv
AGENT_PROTOCOL=opencode
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Qoder 使用本机 `qodercli --acp`，没有 HTTP 后台地址：

```dotenv
AGENT_PROTOCOL=qoder
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

统一 ACP Adapter 为每个用户维护一个固定的原生协调 Session，并通过 ACP 的
Session list/resume/new 能力和动态 MCP 工具提供列出、新建、继续、查询和取消
项目 Session 的能力。继续已有项目时使用目标 Session 的原始 `session_id` 和
工作目录执行 `session/resume`，交互会追加到原生 CLI Session 历史。

认证复用 `qodercli` 当前登录状态或它支持的环境变量。高级配置：

```dotenv
QODERCLI_PATH=
QODER_CONFIG_DIR=
```

Gateway 管理 Qoder ACP 子进程；Qoder 不接受 `--backend-url`。

### Kimi Code

Kimi Code（[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)）
通过官方原生 ACP 入口 `kimi acp` 接入。当前集成验证并要求 Kimi Code `0.31.0`
或更高版本；`qwenaudio setup --backend kimi` 会同时检查可执行文件和版本，并拒绝
低于兼容基线的旧实现。

可使用官方安装脚本安装经过验证的版本：

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | \
  KIMI_VERSION=0.31.0 KIMI_INSTALL_DIR="$HOME/.local" \
  KIMI_NO_MODIFY_PATH=1 bash
```

已经通过 Kimi Code 自身完成登录时，只需选择后台：

```dotenv
AGENT_PROTOCOL=kimi
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

也可以使用 Kimi Code 官方的临时模型环境变量，在不改写
`~/.kimi-code/config.toml` 的情况下提供 Kimi Code API Key：

```dotenv
AGENT_PROTOCOL=kimi
KIMI_MODEL_NAME=kimi-for-coding
KIMI_MODEL_API_KEY=your-kimi-code-key
KIMI_MODEL_BASE_URL=https://api.kimi.com/coding/v1
```

`config.env` 由 qwen-audio-agent 创建为仅当前用户可读写的 `0600` 文件，禁止将
实际 API Key 写入仓库。Kimi Code 的原生配置、OAuth 凭据和 Session 存储默认仍
由 Kimi 自己管理；qwen-audio-agent 不修改这些文件。设置 `KIMI_CODE_HOME` 可以
显式选择另一套 Kimi 数据目录，设置 `KIMI_WORKSPACE` 可以覆盖协调工作区。

显式设置 `QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，Gateway 会通过 ACP
`session/set_config_option` 覆盖 Kimi Session 模型并确认生效；留空则由 Kimi
选择自身默认模型。高级配置：

```dotenv
KIMI_CODE_BIN=
KIMI_WORKSPACE=
KIMI_CODE_HOME=
```

其他支持 ACP stdio 的 Agent 可使用通用入口：

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent
ACP_ARGS=["--acp"]
ACP_LABEL=Your Agent
ACP_WORKSPACE=
```

通用入口由 Gateway 直接管理 ACP 子进程。`ACP_ARGS` 推荐写成
JSON 字符串数组，以便参数中包含空格时仍能准确解析。它使用标准 ACP Session 和
Gateway 提供的 Session MCP 工具，不假设某个 Agent 私有的启动、权限或 UI 能力。

### Hermes

Hermes Agent（[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)）
自带 ACP 模式，Gateway 使用 `hermes acp` 启动：

```dotenv
AGENT_PROTOCOL=hermes
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Hermes 默认使用自身配置的模型与 provider。显式设置
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，Gateway 才会通过 ACP 覆盖其 Session
模型。首次使用前可运行 `hermes acp --check` 检查依赖。高级配置：

```dotenv
HERMES_BIN=
HERMES_WORKSPACE=
```

如果 `session/new` 因不可达的 provider 模型目录而长时间等待，可在
`~/.hermes/config.yaml` 中通过 `model_catalog.excluded_providers` 排除没有使用的
provider。

### CodeBuddy

CodeBuddy Code（腾讯 `@tencent-ai/codebuddy-code`）使用
`codebuddy --acp`。其 ACP 模式需要账号认证；首次使用前应交互式运行
`codebuddy`，并通过 `/login` 完成一次登录。

```dotenv
AGENT_PROTOCOL=codebuddy
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

默认直接使用 CodeBuddy 已有的模型配置。只有显式设置
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，协调工作区才会生成项目级
`.codebuddy/models.json`，通过环境变量读取指定的模型与地址。高级配置：

```dotenv
CODEBUDDY_BIN=
CODEBUDDY_WORKSPACE=
CODEBUDDY_MODEL_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

取消模型覆盖后，Gateway 会移除自己生成的 `.codebuddy/models.json`，恢复
CodeBuddy 原有模型；用户手动修改的文件始终保留。启用覆盖时，
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 的变化会自动同步到系统生成的文件。

### Codex

Codex（[openai/codex](https://github.com/openai/codex)）通过 ACP 项目维护的
[codex-acp](https://github.com/agentclientprotocol/codex-acp) 接入。启动脚本优先
绑定用户环境中已安装的 `codex`，并优先使用已安装的 `codex-acp`；缺少 Adapter
时通过 `npx` 使用固定版本。

```dotenv
AGENT_PROTOCOL=codex
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

默认复用用户的 `~/.codex`、登录状态和模型。只有显式设置
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时才覆盖模型；`CODEX_BASE_URL` 只用于配置
自定义模型服务地址。两者都不会修改用户配置文件。高级配置：

```dotenv
CODEX_ACP_BIN=
CODEX_ACP_PACKAGE=@agentclientprotocol/codex-acp@1.1.7
CODEX_ACP_RUNTIME=auto
CODEX_PATH=
CODEX_WORKSPACE=
CODEX_BASE_URL=
```

### Claude Code

Claude Code 通过 Zed 维护的
[@zed-industries/claude-code-acp](https://github.com/zed-industries/claude-code-acp)
接入。启动脚本优先使用已经安装的 `claude-code-acp`，否则通过 `npx` 使用固定
版本；无需单独安装 ACP 适配器，但需要先安装并认证 Claude Code。

```dotenv
AGENT_PROTOCOL=claude
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

模型和凭据默认由 Claude Code 自己管理，并复用 `~/.claude` 中已有的登录状态；
也可以设置 `ANTHROPIC_API_KEY`。显式设置 `QWEN_AUDIO_AGENT_BACKEND_MODEL`
时，Gateway 才会通过 ACP 覆盖其 Session 模型。高级配置：

```dotenv
CLAUDE_CODE_ACP_BIN=
CLAUDE_CODE_ACP_PACKAGE=@zed-industries/claude-code-acp@0.16.2
CLAUDE_CODE_ACP_RUNTIME=auto
CLAUDE_WORKSPACE=
CLAUDE_CODE_EXECUTABLE=
CLAUDE_CONFIG_DIR=
```

设置 `CLAUDE_CONFIG_DIR` 会改用独立配置目录，需要在该目录中单独完成认证。
`CLAUDE_CODE_EXECUTABLE` 只用于覆盖适配器默认使用的 Claude Code 可执行文件。

Kimi Code、Hermes、CodeBuddy、Codex 和 Claude Code 均由 Gateway 直接管理 ACP
子进程，不接受 `--backend-url`。

## 后台权限模式

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` 可设为：

- `native`（默认）：权限由后台 Agent 自己判断和询问，Gateway 只负责原样转发。
- `full`：启动时明确授予最高权限，后台可直接执行命令、读写文件，不再逐次确认。

`full` 当前支持 OpenCode、Qoder、Kimi Code、Hermes、CodeBuddy、Codex 和
Claude Code。Gateway 会自动批准这些 ACP 后台发起的权限请求；此外 Kimi Code
会通过 ACP Session 配置切换到不会再提问的 Auto 模式，Qoder 和 CodeBuddy CLI
会使用 `--dangerously-skip-permissions`，OpenCode 会在受管进程的内联配置中为协调
Agent 和任务 Agent 设置 `permission: "allow"`，Codex 会使用
`agent-full-access` 模式。Kimi Code 的 YOLO 模式仍可能向用户提问，因此这里不会
用它映射 `full`。

OpenClaw 的执行授权同时受 exec approvals、elevated 和执行 host 等配置约束，
无法由一个统一开关安全、完整地表达；选择 `full` 时 Gateway 会明确拒绝启动，
需要按 OpenClaw 自身方式单独配置。最高权限会放大误操作风险，只应在可信项目和
可信提示词环境中启用。

桌面版、CLI 和 WebUI 可以复用同一个 Gateway，但同一用户同时只有一个活跃语音
入口。CLI 默认不抢占现有桌面语音；需要明确接管时使用：

```bash
qwenaudio tui --takeover
```

同一用户只能运行一个 TUI。Gateway、桌面应用和 WebUI 可以同时驻留；桌面球会在
TUI 接管语音期间显示占用状态。

## 远程访问安全

Gateway 默认只信任字面量 loopback Host/Origin，避免恶意网页通过 DNS rebinding
连接本机语音与后台 Agent。若要从其他设备访问，不要直接设置 `HOST=0.0.0.0`
后暴露端口；应使用具备访问认证的 HTTPS 反向代理，并配置公开 Origin：

```dotenv
HOST=127.0.0.1
QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com
```

反向代理必须：

- 在转发前完成用户认证；
- 只接受 HTTPS，并正确转发 WebSocket；
- 保留公开 `Host`；
- 将流量转发至本机 `127.0.0.1:3101`。

`QWEN_AUDIO_AGENT_AUTH_SECRET` 只用于签署本地身份，不是远程访问密码。不得用它
替代反向代理认证。多个可信 Origin 可使用英文逗号分隔。

## Gateway 运行方式

Gateway 默认启动并管理所选 Agent 的 ACP 进程。若 OpenCode 或 OpenClaw 的本地
服务端口已被其他进程占用，会选择空闲端口，不会接管或关闭用户进程。OpenClaw
始终由 qwen-audio-agent 启动独立 Gateway，并使用隔离的运行状态和 Session
存储；它可以读取用户已有的模型与能力配置，但不会与用户常驻 Gateway 共享
Session，也不会重复连接用户配置的外部消息渠道。OpenCode 的 ACP 进程始终
复用其原生配置和 Session 存储，原生界面不可用不影响 ACP 任务执行。

`qwenaudio`、`qwenaudio gateway` 和 `qwenaudio gateway run` 都在前台运行。
需要后台常驻时使用：

```bash
qwenaudio gateway install    # 安装并立即启动用户服务
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

后台服务每次启动都会重新读取 `config.env`。修改配置后执行
`qwenaudio gateway restart` 即可生效。服务日志位于
`~/.config/qwaudio/logs/gateway.log`；Linux 也可以通过
`journalctl --user -u qwen-audio-agent-gateway` 查看。

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
插件可以继续使用。协调规则和第三层 Session 工具由 Gateway 在每轮请求中通过
ACP 动态提供，不会额外安装或覆盖 OpenCode Agent。

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
| `OPENCODE_WORKSPACE` | 用户配置目录下的 `workspaces/opencode` |
| `QODER_WORKSPACE` | 用户配置目录下的 `workspaces/qoder` |
| `QWEN_AUDIO_AGENT_BACKEND_MODEL` | 空；使用后台 Agent 原有模型 |
| `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` | `native` |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` |
| `QWEN_AUDIO_REALTIME_PROVIDER` | `dashscope` |
| `QWEN_AUDIO_REALTIME_VOICE` | `longanqian` |
| `QWEN_AUDIO_AGENT_IDENTITY_MODE` | `personal` |
| `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE` | `half` |
| `AGENT_TIMEOUT_MS` | `300000` |

macOS TUI 的 CoreAudio 辅助程序默认编译到
`~/Library/Caches/qwaudio/tui/macos-voice-io`，无需额外配置。它在播报期间
持续收音，只支持语音打断。
Linux 和 Windows 的 minimal TUI 通过随包提供的 Python 音频桥接使用
`sounddevice`/PortAudio 半双工；播放回复时麦克风会暂停，只支持通过 `x` 键
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
