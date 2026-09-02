# 后台配置

## 后台 Setup 检查

配置后台 Agent 后，可运行统一的只读检查：

```bash
qwenaudio setup
```

它会检查后台可执行文件、ACP 接入方式和必要的 Adapter，并明确显示当前选择。
检查命令本身不会安装或下载后台 Agent，不会触发登录，也不会输出或验证凭据、修改模型
配置。它会提示 OpenCode/OpenClaw 是否能在正式启动时自动下载和配置；其他后台
的配置状态由 Agent 自己管理。

只检查指定后台或获取机器可读结果：

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

JSON 输出与 CLI 使用同一个共享检测模块，可供桌面版和其他工具直接复用。

## 一键安装后台 Agent

未安装的后台 Agent 可用统一命令安装到本机：

```bash
qwenaudio install codex
qwenaudio install deepseek
```

- 安装前先检测，只补齐缺失的组件：原生 ACP 后台装好即可用；本体缺失时装本体；
  本体已装、仅缺 ACP 适配器时只装适配器；全部就绪时直接提示已可用。
- 安装规格（官方 npm 包与锁定版本、官方安装脚本）由 CLI 与桌面版共享同一份
  定义，版本与 `scripts/` 下 managed 启动脚本保持一致；可用对应环境变量覆盖，
  如 `OPENCODE_PACKAGE`、`CODEX_ACP_PACKAGE`、`CLAUDE_CODE_ACP_PACKAGE`。
- Codex、Claude Code 的 ACP 适配器随本体一并提供；Hermes 使用官方安装
  脚本。脚本类步骤执行前会逐个展示完整命令并等待确认，`--yes` 跳过确认
  （谨慎使用）。
- 安装完成后自动重新检测该后台的可用状态；需要初始化、登录或填写凭据的后台会
  给出统一的“配置”入口。
- 通用 `acp` 后台不提供一键安装，请自行安装后通过 `ACP_COMMAND` 配置。
- 桌面版设置页的“后台 Agent”列表中，未安装且支持一键安装的后台行尾会显示
  “安装”按钮，与 CLI 使用同一份安装逻辑；脚本类安装会弹出原生确认框。

桌面版只提供统一的安装、配置和连接状态外壳，不理解具体 Agent 的登录流程。
每个后台 Onboarding Adapter 声明自己的受信配置入口与状态检测方式；目前入口可以
打开官方终端流程，后续也可扩展为网页、表单或纯说明，而不需要修改设置页的产品逻辑。
渲染层只提交后台 ID，不能自行拼接或执行配置命令。

安装 DeepSeek Harness 后运行 `dsh web`，在模型设置中配置官方
API Key，ACP 接入会直接复用该凭据。它的模型配置独立于其他后台，避免把 Qwen 等
模型名称误传给 DeepSeek：

```dotenv
AGENT_PROTOCOL=deepseek
# 可选：deepseek-v4-pro（默认）或 deepseek-v4-flash
DEEPSEEK_HARNESS_MODEL=deepseek-v4-pro
```

仍可通过 `DEEPSEEK_API_KEY` 为单次运行显式覆盖凭据。

## 技能管理

后台 Agent 负责执行实际任务，因此标准 Agent Skills（开放格式的
`SKILL.md` 目录）是为后台安装的。`qwenaudio skill` 是社区标准
[skills.sh](https://skills.sh) 安装器（`npx skills`）的品牌入口：每条命令都是
1:1 透传，只有一点不同——安装目标是本机实际存在的后台（CLI 探测）加上
当前配置的后台，而不是依赖 skills.sh 自己的 Agent 探测。

```bash
qwenaudio skill install <来源> --skill <名称>   # 安装到各后台
qwenaudio skill install <来源> --list           # 列出来源中的技能
qwenaudio skill list                            # 列出已安装技能
qwenaudio skill remove <名称>                   # 移除技能
qwenaudio skill update                          # 更新已安装技能
```

支持的来源形式与 skills.sh 一致：

| 来源形式 | 示例 |
| --- | --- |
| GitHub 简写 | `qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines` |
| 仓库 URL（GitHub/GitLab/任意 git） | `qwenaudio skill install https://github.com/alirezarezvani/claude-skills --skill skill-security-auditor` |
| Tree URL（技能子目录） | `qwenaudio skill install https://github.com/o/r/tree/main/skills/x --skill x` |
| Hub 技能页 URL | `qwenaudio skill install https://clawhub.ai/thcjp/skills/excel-formula-tool-free --skill excel-formula-tool-free` |
| 本地目录 | `qwenaudio skill install ./my-skill --skill my-skill` |

多技能仓库必须带 `--skill`（重复可装多个）；先用 `--list` 查看来源提供的技能。
刻意不支持一次安装整个大型目录——每个技能描述都会注入后台系统提示词。

技能落到各后台 CLI 自己的用户级目录（`~/.claude/skills/`、`~/.qwen/skills/`、
`~/.openclaw/skills/`、`~/.agents/skills/` 等），因此直接使用这些 CLI 时也生效，
桌面版与 CLI 共享同一套技能。

切换到——或新安装——缺少已安装技能的后台时，Gateway 会在启动时同步补齐：
先对 skills.sh 锁文件（`~/.agents/.skill-lock.json`）做毫秒级本地检查，仅在确实
缺失时才在后台进程启动前跑一次 skills.sh（数秒），保证后台首次扫描即看到完整
技能集。失败（例如离线）只记日志，绝不阻塞语音网关。

钉住的 skills.sh 版本可用 `QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` 覆盖（例如
`skills@latest`）。如果新后台尚未被 skills.sh 支持，可以向它的 `src/agents.ts`
提交 Agent 定义——那是官方扩展点。

### 技能何时生效

文件立即同步，但各后台按自己的节奏发现新技能：

| 后台 | 发现机制 | 新技能可见时机 |
| --- | --- | --- |
| Claude Code、Qwen Code、Hermes、DeepSeek | 热加载（watcher 或按需读取） | 立即，无需操作 |
| Qoder | 会话开始时；原生会话内可 `/skills reload` | 下一个后台会话 |
| OpenCode、OpenClaw、Kimi Code、CodeBuddy、Codex | 进程或会话启动时快照 | 后台进程重启后 |

如果新装的技能没被发现，`qwenaudio gateway restart` 重启后台进程即可解决。

### 共享后台 workspace

所有后台现在共享同一个默认工作目录 `<config-dir>/workspace`，切换后台时
无缝衔接同一批文件。按后台覆盖（例如 `OPENCODE_WORKSPACE`）在显式设置时仍然
可以隔离特定后台。

## 选择后台

`AGENT_PROTOCOL` 没有默认值，也是可选配置。留空时 Gateway 仅提供前台实时语音
聊天；需要后台执行的请求会返回明确错误，不会创建任务或猜测执行结果。
也可以使用 `qwenaudio --backend none` 显式启动仅前台模式。

OpenClaw 默认地址为 `http://127.0.0.1:18789`。显式设置
`OPENCLAW_BASE_URL` 时，qwen-audio-agent 会把该 Gateway 作为外部黑盒直接连接，
不会另起 OpenClaw Gateway，也不会读取、复制或修改它的模型认证数据：

```dotenv
AGENT_PROTOCOL=openclaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
```

远程部署可以使用 `https://` 或 `wss://` 地址；跨机器连接建议使用 `wss://`，不要把
Token 写进 URL：

```dotenv
AGENT_PROTOCOL=openclaw
OPENCLAW_BASE_URL=wss://openclaw.example.com
OPENCLAW_GATEWAY_TOKEN=replace-with-your-token
```

外部模式仍会在 qwen-audio-agent 本机启动轻量的官方 `openclaw acp` bridge，并通过
stdio ACP 与它通信；该 bridge 再连接用户管理的远程 Gateway。qwen-audio-agent 不会
启动、停止、改端口或修改远程 Gateway。远程模式不做 300ms 本地端口预判，而由官方
bridge 返回实际的网络、TLS 和认证错误。如果本机安全软件终止 bridge，本轮会明确失败，
但远程 Gateway 不受影响。

如果本机安全策略只拦截 qwen-audio-agent 的 OpenClaw 启动包装层，可以显式指定一个
受信任的 OpenClaw 可执行文件，Gateway 将直接用它启动轻量 bridge：

```dotenv
OPENCLAW_ACP_BIN=/absolute/path/to/openclaw
```

这不会改变远程 Gateway 的所有权；该进程仍只是本地 ACP bridge，并随
qwen-audio-agent Gateway 关闭。

未设置 `OPENCLAW_BASE_URL` 时，默认优先启动用户环境中的 `openclaw`。同时提供
`DASHSCOPE_API_KEY` 和
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，会为 qwen-audio-agent 进程生成独立的
百炼配置和状态目录，不修改用户原生配置。未指定后台模型时则继承用户的原生
配置、模型和认证，但不会在独立实例中启用钉钉等外部消息渠道。自管模式下若原配置
启用了 Gateway Token，会自动读取并用于本地 ACP 连接；也可以通过
`OPENCLAW_GATEWAY_TOKEN` 覆盖，或设置 `OPENCLAW_CONFIG_PATH` 明确指定另一份
OpenClaw 配置。连接外部 Gateway 时，应同时设置 `OPENCLAW_GATEWAY_TOKEN`（或
`OPENCLAW_GATEWAY_TOKEN_FILE`）。

上述模型值只用于本机托管实例的启动前初始化。连接外部 OpenClaw 时，Session
模型覆盖必须由其 ACP bridge 通过标准 `configOptions` 声明；Gateway 不再调用
OpenClaw 私有 `sessions.patch` 接口修改模型。

OpenCode：Gateway 通过 `opencode acp` 与它交互，并管理用于打开原生 Session
界面的本地服务。没有兼容安装时会自动使用固定 npm 包，用户不需要另行安装或
启动服务。`OPENCODE_BASE_URL` 是该本地 Session UI 服务的地址，并不是可供
qwen-audio-agent 连接的远程 ACP 执行地址：

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

### Qwen Code

Qwen Code 通过官方本地 stdio ACP 入口 `qwen --acp` 接入。Gateway 只负责启动
这个 ACP 进程，认证、Provider、模型、MCP、Skill 和 Session 配置均复用 Qwen
Code 自身配置。

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

首次认证请直接运行 `qwen`，然后使用 `/auth`；已经移除的 `qwen auth` 不会被调用。
可选覆盖：

```dotenv
QWEN_CODE_BIN=
QWEN_CODE_WORKSPACE=
```

当前仅支持本地 ACP 进程，暂不把 Qwen Code 的实验性网络服务作为远程后台。

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

不提供 ACP 的办事系统可以在自定义 Node 启动器中实现 `BackendPort`，详见
[Backend Adapter SDK](../reference/backend-adapter-sdk.zh.md)。SDK 接入不新增
`AGENT_PROTOCOL` 名称，也不会让配置文件动态加载任意代码。

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

默认直接使用 CodeBuddy 已有的模型配置。显式设置
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，只会在 CodeBuddy ACP 声明标准模型选项后
通过 `session/set_config_option` 覆盖；Gateway 不传 `--model`，也不生成项目级
`.codebuddy/models.json`。高级配置：

```dotenv
CODEBUDDY_BIN=
CODEBUDDY_WORKSPACE=
CODEBUDDY_MODEL_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

`CODEBUDDY_MODEL_URL` 是 CodeBuddy 自身的 Provider 地址，不代表 Session 模型已经
切换；模型是否生效仍以 ACP 返回的 `configOptions` 为准。

### Codex

Codex（[openai/codex](https://github.com/openai/codex)）通过 ACP 项目维护的
[codex-acp](https://github.com/agentclientprotocol/codex-acp) 接入。启动脚本优先
绑定用户环境中已安装的 `codex`，并优先使用已安装的 `codex-acp`；缺少 Adapter
时通过 `npx` 使用固定版本。

```dotenv
AGENT_PROTOCOL=codex
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

默认复用用户的 `~/.codex`、登录状态和模型。显式设置
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 时，只通过 ACP 标准模型选项覆盖 Session；
`CODEX_BASE_URL` 只配置自定义 Provider 地址，不再向 `CODEX_CONFIG` 写入模型。
两者都不会修改用户配置文件。高级配置：

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

### Pi

Pi（earendil-works 的 [pi coding agent](https://pi.dev)，npm 包
`@earendil-works/pi-coding-agent`）没有原生 ACP 入口，通过社区适配器
[pi-acp](https://github.com/svkozak/pi-acp) 接入。Gateway 会启动 `pi-acp`，
由它内部拉起 `pi --mode rpc`；pi-acp 要求 pi `0.80.4` 或更高版本。

一键安装会同时安装本体与适配器：

```bash
qwenaudio install pi
```

也可以手动安装这两个包：

```bash
npm install -g @earendil-works/pi-coding-agent pi-acp
```

认证：交互式运行 `pi` 并通过 `/login` 完成登录（支持 Claude Pro/Max、
ChatGPT、GitHub Copilot 订阅 OAuth），或设置官方 API Key 环境变量
（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等 30+ provider）；
Gateway 会把环境变量透传给后台进程。然后选择后台：

```dotenv
AGENT_PROTOCOL=pi
```

pi-acp 支持通过 `session/load` 恢复历史 pi Session。高级配置：

```dotenv
PI_BIN=
PI_ACP_BIN=
PI_WORKSPACE=
PI_ACP_RUNTIME=auto
```

- `PI_BIN` / `PI_ACP_BIN` 分别覆盖 pi 本体与 pi-acp 适配器的可执行文件路径。
- `PI_WORKSPACE` 覆盖工作目录（默认 `~/.config/qwaudio/workspace`，与其他托管后台共享）。
- `PI_ACP_RUNTIME`（`auto` / `binary` / `package`）控制适配器使用本地二进制
  还是通过 `npx` 按需启动。

> **警告：Pi 没有任何权限审批机制。** Pi 官方明确 "No Built-in Sandbox"——
> read、write、bash 直接以当前用户权限执行；pi-acp 也未实现 ACP
> `session/request_permission`。因此无论
> `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` 如何配置，Pi 都**始终等效
> `full` 权限**，语音会话中不会出现任何权限确认环节。只在可信项目和可信
> 提示词环境中使用。

当前社区适配器虽然接收 ACP `mcpServers`，但尚未把它们接入 Pi。因此该后台
暂不提供 Gateway Session 工具和第三层独立任务委派；Pi 会使用自身工具在当前
Session 内完成工作。

Kimi Code、Hermes、CodeBuddy、Codex、Claude Code 和 Pi 均由 Gateway 直接管理 ACP
子进程，不接受 `--backend-url`。

## 后台权限模式

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` 可设为：

- `native`（默认）：权限由后台 Agent 自己判断和询问，Gateway 只负责原样转发。
- `full`：启动时明确授予最高权限，后台可直接执行命令、读写文件，不再逐次确认。

`full` 当前支持 OpenCode、Qoder、Qwen Code、Kimi Code、Hermes、CodeBuddy、Codex 和
Claude Code。Gateway 会自动批准这些 ACP 后台发起的权限请求；此外 Kimi Code
会通过 ACP Session 配置切换到不会再提问的 Auto 模式，Qoder 和 CodeBuddy CLI
会使用 `--dangerously-skip-permissions`，OpenCode 会在受管进程的内联配置中为协调
Agent 和任务 Agent 设置 `permission: "allow"`，Codex 会使用
`agent-full-access` 模式。Kimi Code 的 YOLO 模式仍可能向用户提问，因此这里不会
用它映射 `full`。

Pi 是特例：它没有任何内置沙箱或权限审批机制，适配器 pi-acp 也未实现 ACP
`session/request_permission`，因此无论配置哪种权限模式，Pi 都始终等效
`full` 权限运行——这不是“支持 `full`”，而是根本不存在审批环节。Pi 通过
`alwaysFullPermission` 后台能力声明这一点：配置解析与 Gateway 健康状态都会
归一化并展示真实生效的 `full`（而不是具有误导性的 `native`）。只在可信项目和
可信提示词环境中使用。

OpenClaw 的执行授权同时受 exec approvals、elevated 和执行 host 等配置约束，
无法由一个统一开关安全、完整地表达；选择 `full` 时 Gateway 会明确拒绝启动，
需要按 OpenClaw 自身方式单独配置。最高权限会放大误操作风险，只应在可信项目和
可信提示词环境中启用。
