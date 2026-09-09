# Backend-Specific Settings

Find the backend you use; you do not need to configure every integration. See
[common backend settings](../configuration/backend.md) for installation, standard model overrides,
and permissions, or [supported backends](overview.md) for an overview.

## OpenClaw

The default OpenClaw address is `http://127.0.0.1:18789`. When
`OPENCLAW_BASE_URL` is set explicitly, qwen-audio-agent connects to that
Gateway as an external black box. It does not start another OpenClaw Gateway
or read, copy, or modify the Gateway's model credentials:

```dotenv
AGENT_PROTOCOL=openclaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
```

For a remote deployment, use an `https://` or `wss://` address. Prefer
`wss://` across machines and never embed the token in the URL:

```dotenv
AGENT_PROTOCOL=openclaw
OPENCLAW_BASE_URL=wss://openclaw.example.com
OPENCLAW_GATEWAY_TOKEN=replace-with-your-token
```

External mode still starts the lightweight official `openclaw acp` bridge on
the qwen-audio-agent host and speaks ACP over stdio to it. The bridge then
connects to the user-managed remote Gateway. qwen-audio-agent never starts,
stops, reconfigures, or moves that remote Gateway. The official bridge reports
the real network, TLS, and authentication error instead of using the 300 ms
local startup probe. If local security software terminates the bridge, the turn
fails explicitly while the remote Gateway remains untouched.

If local security policy blocks only qwen-audio-agent's OpenClaw launcher,
point to a trusted OpenClaw executable and the Gateway will run the lightweight
bridge directly:

```dotenv
OPENCLAW_ACP_BIN=/absolute/path/to/openclaw
```

This does not change ownership of the remote Gateway. The local process remains
an ACP bridge and is stopped with the qwen-audio-agent Gateway.

When `OPENCLAW_BASE_URL` is not set, it preferentially launches the `openclaw`
in the user environment. When both
`DASHSCOPE_API_KEY` and `QWEN_AUDIO_AGENT_BACKEND_MODEL` are provided, an independent Bailian
configuration and state directory is generated for the qwen-audio-agent process, without
modifying the user's native configuration. When no backend model is specified, it inherits the
user's native configuration, models, and authentication, but does not enable external messaging
channels such as DingTalk in the independent instance. In managed mode, if the original configuration
has enabled a Gateway Token, it will be automatically read and used for local ACP connections; it can
also be overridden via `OPENCLAW_GATEWAY_TOKEN`, or `OPENCLAW_CONFIG_PATH` can be set to explicitly
specify a different OpenClaw configuration. When connecting to an external Gateway, also set
`OPENCLAW_GATEWAY_TOKEN` (or `OPENCLAW_GATEWAY_TOKEN_FILE`).

That model value is only used to provision a locally managed instance before startup. For an
external OpenClaw Gateway, a Session model override requires its ACP bridge to advertise standard
`configOptions`; the Gateway no longer calls the private OpenClaw `sessions.patch` RPC.

## OpenCode

The Gateway interacts with it via `opencode acp` and manages the local service used
to open the native Session interface. When there is no compatible installation, it automatically
uses a fixed npm package; users do not need to separately install or start the service.
`OPENCODE_BASE_URL` names that local Session UI service; it is not a remote ACP execution
endpoint that qwen-audio-agent can attach to:

```dotenv
AGENT_PROTOCOL=opencode
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

## Qoder

Qoder uses the local `qodercli --acp` and has no HTTP backend address:

```dotenv
AGENT_PROTOCOL=qoder
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

The unified ACP Adapter maintains a fixed native coordination Session for each user, and
provides the ability to list, create, continue, query, and cancel project Sessions through
ACP's Session list/resume/new capabilities and dynamic MCP tools. When continuing an existing
project, it executes `session/resume` using the target Session's original `session_id` and
working directory; interactions are appended to the native CLI Session history.

Authentication reuses the `qodercli` current login state or its supported environment variables.
Advanced configuration:

```dotenv
QODERCLI_PATH=
QODER_CONFIG_DIR=
```

The Gateway manages the Qoder ACP subprocess; Qoder does not accept `--backend-url`.

## Qwen Code

Qwen Code connects through its native stdio ACP entry point, `qwen --acp`.
The Gateway starts only this local ACP process and preserves Qwen Code's own
authentication, provider, model, MCP, Skill, and Session configuration.

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Run `qwen` interactively and use `/auth` for first-time authentication. The
removed `qwen auth` command is not used. Optional overrides:

```dotenv
QWEN_CODE_BIN=
QWEN_CODE_WORKSPACE=
```

The current integration intentionally supports the local ACP process only;
Qwen Code's experimental network service is not treated as a remote backend.

## MiniMax Code

MiniMax Code ([official CLI documentation](https://agent.minimax.io/docs/cli/features))
connects through the official `mcode acp` ACP v1/stdio entry point. The Gateway
starts only this local ACP process; MiniMax Code owns its authentication,
Provider, model, Session, and Skill/Plugin configuration. The current integration
requires MiniMax Code `0.3.7` or later.

Install the official CLI with the unified command:

```bash
qwenaudio install minimax
```

Authenticate for the first time:

```bash
mcode login
```

For a Global account, use `mcode login --region global`; configure a custom
Provider or API key with `mcode provider`. After configuring MiniMax Code itself,
select it as the backend:

```dotenv
AGENT_PROTOCOL=minimax
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Advanced options:

```dotenv
MINIMAX_CODE_BIN=
MINIMAX_CODE_WORKSPACE=
```

Avoid setting `QWEN_AUDIO_AGENT_BACKEND_MODEL` for MiniMax Code. If it is set
explicitly, the Gateway attempts an override only when MiniMax advertises a
compatible standard ACP `configOptions` entry; otherwise it fails explicitly.
MiniMax Code's public documentation does not declare a skills.sh-compatible user
directory, so `qwenaudio skill` does not copy skills into its private Skill/Plugin
store; use MiniMax Code's own management flow.

## Kimi Code

Kimi Code ([MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code))
connects via the official native ACP entry point `kimi acp`. The current integration verifies
and requires Kimi Code `0.31.0` or higher; `qwenaudio setup --backend kimi` checks both the
executable and version, and rejects older implementations below the compatible baseline.

You can install the verified version using the official installation script:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | \
  KIMI_VERSION=0.31.0 KIMI_INSTALL_DIR="$HOME/.local" \
  KIMI_NO_MODIFY_PATH=1 bash
```

When you have already completed login through Kimi Code itself, you only need to select the
backend:

```dotenv
AGENT_PROTOCOL=kimi
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

You can also use Kimi Code's official temporary model environment variables to provide a Kimi
Code API Key without modifying `~/.kimi-code/config.toml`:

```dotenv
AGENT_PROTOCOL=kimi
KIMI_MODEL_NAME=kimi-for-coding
KIMI_MODEL_API_KEY=your-kimi-code-key
KIMI_MODEL_BASE_URL=https://api.kimi.com/coding/v1
```

`config.env` is created by qwen-audio-agent as a `0600` file readable and writable only by the
current user; writing actual API keys to the repository is prohibited. Kimi Code's native
configuration, OAuth credentials, and Session storage are still managed by Kimi by default;
qwen-audio-agent does not modify these files. Setting `KIMI_CODE_HOME` can explicitly select a
different Kimi data directory, and setting `KIMI_WORKSPACE` can override the coordination
workspace.

When `QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicitly set, the Gateway overrides the Kimi Session
model via ACP `session/set_config_option` and confirms it takes effect; if left blank, Kimi
selects its own default model. Advanced configuration:

```dotenv
KIMI_CODE_BIN=
KIMI_WORKSPACE=
KIMI_CODE_HOME=
```

Other Agents that support ACP stdio can use the generic entry point:

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent
ACP_ARGS=["--acp"]
ACP_LABEL=Your Agent
ACP_WORKSPACE=
```

The generic entry point has the Gateway directly manage the ACP subprocess. `ACP_ARGS` is
recommended to be written as a JSON string array so that arguments containing spaces can still
be parsed accurately. It uses standard ACP Sessions and Gateway-provided Session MCP tools, and
does not assume any Agent's private startup, permission, or UI capabilities.

Action systems without ACP can implement `BackendPort` in a custom Node
launcher; see the [Backend Adapter SDK](../reference/backend-adapter-sdk.md). SDK
composition does not add an `AGENT_PROTOCOL` name or let configuration files
dynamically load arbitrary code.

## Hermes

Hermes Agent ([nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent))
comes with an ACP mode; the Gateway starts it using `hermes acp`:

```dotenv
AGENT_PROTOCOL=hermes
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Hermes uses its own configured model and provider by default. Only when
`QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicitly set will the Gateway override its Session
model via ACP. Before first use, you can run `hermes acp --check` to check dependencies.
Advanced configuration:

```dotenv
HERMES_BIN=
HERMES_WORKSPACE=
```

If `session/new` waits for a long time due to an unreachable provider model catalog, you can
exclude unused providers via `model_catalog.excluded_providers` in `~/.hermes/config.yaml`.

## CodeBuddy

CodeBuddy Code (Tencent's `@tencent-ai/codebuddy-code`) uses `codebuddy --acp`. Its ACP mode
requires account authentication; before first use, you should run `codebuddy` interactively
and complete a login via `/login`.

```dotenv
AGENT_PROTOCOL=codebuddy
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

By default, it directly uses CodeBuddy's existing model configuration. When
`QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicit, the Gateway overrides it only through
`session/set_config_option` after CodeBuddy ACP advertises a standard model option; it does not
pass `--model` or generate a project-level `.codebuddy/models.json`. Advanced configuration:

```dotenv
CODEBUDDY_BIN=
CODEBUDDY_WORKSPACE=
CODEBUDDY_MODEL_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

`CODEBUDDY_MODEL_URL` is CodeBuddy's own provider endpoint and does not prove that a Session model
changed; the returned ACP `configOptions` remain authoritative.

## Codex

Codex ([openai/codex](https://github.com/openai/codex)) connects via
[codex-acp](https://github.com/agentclientprotocol/codex-acp) maintained by the ACP project.
The launcher script preferentially binds the `codex` already installed in the user environment,
and preferentially uses the installed `codex-acp`; when the adapter is missing, it uses a fixed
version via `npx`.

```dotenv
AGENT_PROTOCOL=codex
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

By default, it reuses the user's `~/.codex`, login state, and model. An explicit
`QWEN_AUDIO_AGENT_BACKEND_MODEL` overrides a Session only through the standard ACP model option;
`CODEX_BASE_URL` configures a custom provider endpoint and no longer writes a model into
`CODEX_CONFIG`. Neither setting modifies the user's configuration file. Advanced configuration:

```dotenv
CODEX_ACP_BIN=
CODEX_ACP_PACKAGE=@agentclientprotocol/codex-acp@1.1.7
CODEX_ACP_RUNTIME=auto
CODEX_PATH=
CODEX_WORKSPACE=
CODEX_BASE_URL=
```

## Claude Code

Claude Code connects via
[@zed-industries/claude-code-acp](https://github.com/zed-industries/claude-code-acp)
maintained by Zed. The launcher script preferentially uses the already installed
`claude-code-acp`, otherwise uses a fixed version via `npx`; no separate installation of the
ACP adapter is needed, but Claude Code must be installed and authenticated first.

```dotenv
AGENT_PROTOCOL=claude
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

Model and credentials are managed by Claude Code itself by default, reusing the existing login
state in `~/.claude`; you can also set `ANTHROPIC_API_KEY`. Only when
`QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicitly set will the Gateway override its Session
model via ACP. Advanced configuration:

```dotenv
CLAUDE_CODE_ACP_BIN=
CLAUDE_CODE_ACP_PACKAGE=@zed-industries/claude-code-acp@0.16.2
CLAUDE_CODE_ACP_RUNTIME=auto
CLAUDE_WORKSPACE=
CLAUDE_CODE_EXECUTABLE=
CLAUDE_CONFIG_DIR=
```

Setting `CLAUDE_CONFIG_DIR` switches to a separate configuration directory, requiring separate
authentication in that directory. `CLAUDE_CODE_EXECUTABLE` is only used to override the Claude
Code executable used by the adapter by default.

## Pi

Pi (earendil-works' [pi coding agent](https://pi.dev), npm
`@earendil-works/pi-coding-agent`) has no native ACP entry point; it connects via the
community adapter [pi-acp](https://github.com/svkozak/pi-acp). The Gateway spawns
`pi-acp`, which internally launches `pi --mode rpc`; pi-acp requires pi `0.80.4` or
higher.

One-click install installs both the core and the adapter:

```bash
qwenaudio install pi
```

Or install both packages manually:

```bash
npm install -g @earendil-works/pi-coding-agent pi-acp
```

For authentication, run `pi` interactively and complete a login via `/login` (OAuth
with Claude Pro/Max, ChatGPT, or GitHub Copilot subscriptions), or set official API
key environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
and 30+ other providers); the Gateway passes environment variables through to the
backend process. Then select the backend:

```dotenv
AGENT_PROTOCOL=pi
```

pi-acp supports resuming historical pi Sessions via `session/load`. Advanced
configuration:

```dotenv
PI_BIN=
PI_ACP_BIN=
PI_WORKSPACE=
PI_ACP_RUNTIME=auto
```

- `PI_BIN` / `PI_ACP_BIN` override the pi core and pi-acp adapter executables.
- `PI_WORKSPACE` overrides the working directory (default
  `~/.config/qwaudio/data/workspace`, shared with the other managed backends).
- `PI_ACP_RUNTIME` (`auto` / `binary` / `package`) controls whether the adapter uses
  a local binary or starts on demand via `npx`.

> **Warning: Pi has no permission approval mechanism.** Pi officially documents "No
> Built-in Sandbox" — read, write, and bash execute directly with the current user's
> privileges — and pi-acp does not implement ACP `session/request_permission`.
> Therefore Pi is **always equivalent to `full` permission**, regardless of
> `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE`, and no permission confirmation ever
> appears in the voice session. Use it only in trusted projects and trusted prompt
> environments.

The current community adapter accepts ACP `mcpServers` but does not wire them into
Pi. Gateway Session tools and independent third-layer delegation are therefore not
available for this backend; Pi completes work in the current Session with its own
tools.

MiniMax Code, Kimi Code, Hermes, CodeBuddy, Codex, Claude Code, and Pi all have their ACP subprocesses
directly managed by the Gateway, and do not accept `--backend-url`.
