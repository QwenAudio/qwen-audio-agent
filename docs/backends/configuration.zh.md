# 各后台详细配置

只需要找到你选择的后台，不必填写全部配置。安装命令、标准模型覆盖和权限模式见
[后台通用设置](../configuration/backend.zh.md)，支持范围见[后台列表](overview.zh.md)。

## OpenClaw

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

## OpenCode

Gateway 通过 `opencode acp` 与它交互，并管理用于打开原生 Session
界面的本地服务。没有兼容安装时会自动使用固定 npm 包，用户不需要另行安装或
启动服务。`OPENCODE_BASE_URL` 是该本地 Session UI 服务的地址，并不是可供
qwen-audio-agent 连接的远程 ACP 执行地址：

```dotenv
AGENT_PROTOCOL=opencode
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

## Qoder

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

## Qwen Code

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

## MiniMax Code

MiniMax Code（[官方 CLI 文档](https://agent.minimax.io/docs/cli/features)）通过官方
`mcode acp` 以 ACP v1/stdio 接入。Gateway 只启动这个本地 ACP 进程；认证、Provider、
模型、Session 和 Skill/Plugin 配置均由 MiniMax Code 自己管理。当前集成要求 MiniMax
Code `0.3.7` 或更高版本。

可使用统一安装命令安装官方 CLI：

```bash
qwenaudio install minimax
```

首次认证：

```bash
mcode login
```

Global 账号可使用 `mcode login --region global`；自定义 Provider 或 API Key 请运行
`mcode provider` 配置。已经完成 MiniMax Code 自身配置后，只需选择后台：

```dotenv
AGENT_PROTOCOL=minimax
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

高级配置：

```dotenv
MINIMAX_CODE_BIN=
MINIMAX_CODE_WORKSPACE=
```

建议不要用 `QWEN_AUDIO_AGENT_BACKEND_MODEL` 覆盖 MiniMax Code 的模型；如果显式设置，
Gateway 只会在 MiniMax ACP 声明兼容的标准 `configOptions` 时尝试覆盖，否则会明确报错。
由于 MiniMax Code 的公开文档没有声明 skills.sh 兼容的用户目录，`qwenaudio skill` 不会
把技能复制到其私有 Skill/Plugin 存储，请使用 MiniMax Code 自己的管理流程。

## Kimi Code

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

## Hermes

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

## CodeBuddy

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

## Codex

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

## Claude Code

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

## Pi

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
- `PI_WORKSPACE` 覆盖工作目录（默认 `~/.config/qwaudio/data/workspace`，与其他托管后台共享）。
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

## Muse Code

Muse Code 通过 Meta 官方
[`@muse-code/sdk`](https://github.com/meta-models/muse-code-sdk) 和 Muse Session
Protocol（MSP）接入。Gateway 负责启动 `muse serve`，在其生命周期内为每个前台
用户保留一个 Muse Session，并把 MSP 的执行项、权限请求、补充输入、取消和最终
消息统一映射到 `BackendPort`。

在 macOS 或 Linux 安装并完成 Muse Code 自身的登录/配置：

```bash
qwenaudio install muse
muse
```

然后选择该后台：

```dotenv
AGENT_PROTOCOL=muse
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

可选设置：

```dotenv
MUSE_CODE_BIN=muse
MUSE_CODE_WORKSPACE=
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

显式后台模型会作为 MSP `modelId` 传入；留空则沿用 Muse Code 自身配置。
`native` 会把 Muse 提供的权限选项转交给语音/客户端确认流程；`full` 会用 Muse
预配置的 `allowAll` 模式创建 Session，仅应在可信工作区启用。Gateway 的单任务/
当前会话授权只选择 Muse 的单次允许选项，不会创建服务商侧持久授权规则。

当前集成固定使用实验性的 Muse SDK `0.1.1`。首版不会跨 Gateway 重启保存 Muse
Session ID、注入 Gateway MCP Server，也不会读取 MSP `outputRef` 指向的完整字节；
文件改动仍保留在配置的工作区，最终文字会正常返回。当前 Adapter 只把内联图片
作为 MSP 附件发送，其他附件类型会明确拒绝。

Muse Code、MiniMax Code、Kimi Code、Hermes、CodeBuddy、Codex、Claude Code 和 Pi 均由 Gateway 直接管理
子进程，不接受 `--backend-url`。
