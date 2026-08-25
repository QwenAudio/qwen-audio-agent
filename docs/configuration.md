# Configuration

After formal installation, qwen-audio-agent reads settings from a user configuration file:

```text
~/.config/qwaudio/config.env
```

Setting `QWAUDIO_CONFIG_DIR` or `XDG_CONFIG_HOME` can change the configuration directory. The
`.env.local` and `.env` files in the development repository are still supported and take priority
over the user configuration file.

The desktop edition and CLI share one asset layer and keep their runtime state apart, mirroring how
Qoder's IDE and CLI coexist. The shared assets — `config.env`, the local identity (`state.env`),
memory documents (`USER.md`, `MEMORY.md`, `ASSISTANT.md`), frontend notes, the knowledge store,
and the shared agent `workspace/` — live in the CLI's user data directory (`~/.config/qwaudio`, overridable via
`QWAUDIO_DATA_DIR`), so both editions act as the same assistant with one memory and one
configuration. Runtime state — `gateway.lock`, `tasks.json`, ACP session state, logs, and desktop
skins — stays in each edition's own directory: `~/.config/qwaudio` for the CLI and the system
application data directory for the desktop edition (`~/Library/Application Support/Qwen Audio
Agent` on macOS, `~/.config/Qwen Audio Agent` on Linux, `%APPDATA%\Qwen Audio Agent` on Windows).
Both editions can therefore run simultaneously as independent Gateway processes, sessions, tasks,
and logs while sharing the user's assistant profile. Desktop installations upgrading from older
versions copy only assets missing from the shared layer, including an old `workspace/`; when an
asset exists on both sides, neither copy is overwritten or merged automatically. When
`QWAUDIO_CONFIG_DIR` is explicitly set, the desktop edition respects it and keeps assets and runtime
state together in that directory, preserving full isolation for profile scenarios. Writes to shared
memory and notes are serialized across processes so simultaneous Desktop and CLI updates are not
silently lost.

The configuration priority is fixed as:

```text
CLI parameters > process environment variables > .env.local > .env > user configuration file > built-in defaults
```

Run the following command to display the exact location of the current user configuration file:

```bash
qwenaudio config
```

## Backend Setup Check

After configuring the backend Agent, you can run a unified read-only check:

```bash
qwenaudio setup
```

It checks the backend executable, ACP integration method, and necessary Adapters, and clearly
displays the current selection. The check command itself does not install or download the backend
Agent, does not trigger login, and does not output or validate credentials or modify model
configuration. It indicates whether OpenCode/OpenClaw can automatically download and configure
itself at formal startup; the configuration status of other backends is managed by the Agent
itself.

To check only a specified backend or get machine-readable results:

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

The JSON output uses the same shared detection module as the CLI, which can be directly reused
by the desktop edition and other tools.

## One-Click Installation of Backend Agents

Backend Agents that are not installed can be installed on the local machine using a unified
command:

```bash
qwenaudio install codex
qwenaudio install deepseek
```

- Before installation, it detects and only fills in missing components: a native ACP backend is
  ready to use once installed; if the main body is missing, it installs the main body; if the
  main body is installed but only the ACP adapter is missing, it installs only the adapter; if
  everything is ready, it directly prompts that it is available.
- The installation specification (official npm packages with locked versions, official
  installation scripts) is shared between the CLI and desktop edition from the same definition;
  versions are consistent with the managed launcher scripts under `scripts/`; they can be
  overridden with corresponding environment variables, such as `OPENCODE_PACKAGE`,
  `CODEX_ACP_PACKAGE`, `CLAUDE_CODE_ACP_PACKAGE`.
- ACP adapters for Codex and Claude Code are provided together with the main body; Hermes uses
  the official installation script. Script-type steps display the full command before execution
  and wait for confirmation; `--yes` skips confirmation (use with caution).
- After installation, backend availability is detected again automatically; backends that need
  initialization, login, or credentials expose one consistent **Configure** action.
- The generic `acp` backend does not provide one-click installation; please install it yourself
  and configure it via `ACP_COMMAND`.
- In the "Backend Agent" list on the desktop edition settings page, backends that are not
  installed and support one-click installation will display an "Install" button at the end of
  the row, using the same installation logic as the CLI; script-type installations will pop up
  a native confirmation dialog.

Desktop provides a shared shell for installation, configuration, and connection state without
encoding any Agent-specific login flow. Each backend onboarding adapter declares its trusted
configuration entry and status probe. An adapter may open a terminal today and can later provide
a browser, form, or instructions action without changing product-specific logic in Settings.
The renderer submits only a backend ID and can never assemble or execute configuration commands.

After installing DeepSeek Harness,
run `dsh web` and configure the official API key in its model settings. The ACP
integration reuses that credential. Its model setting is intentionally separate
from other backends so Qwen or other provider model names are not forwarded to DeepSeek:

```dotenv
AGENT_PROTOCOL=deepseek
# Optional: deepseek-v4-pro (default) or deepseek-v4-flash
DEEPSEEK_HARNESS_MODEL=deepseek-v4-pro
```

`DEEPSEEK_API_KEY` may still be set as an explicit per-run override.

## Skill Management

Backend agents execute the actual tasks, so standard Agent Skills
(`SKILL.md` folders in the open format) are installed for backends.
`qwenaudio skill` is a branded entry point for the community-standard
[skills.sh](https://skills.sh) installer (`npx skills`): every command is a
1:1 passthrough, with one addition — installs target the backends that
actually exist on this machine (CLI detected) plus the currently configured
backend, instead of relying on skills.sh's own agent detection.

```bash
qwenaudio skill install <source> --skill <name>   # install to every backend
qwenaudio skill install <source> --list           # list skills in a source
qwenaudio skill list                              # list installed skills
qwenaudio skill remove <name>                     # remove a skill
qwenaudio skill update                            # update installed skills
```

Supported sources are whatever skills.sh supports:

| Source form | Example |
| --- | --- |
| GitHub shorthand | `qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines` |
| Repository URL (GitHub/GitLab/any git) | `qwenaudio skill install https://github.com/alirezarezvani/claude-skills --skill skill-security-auditor` |
| Tree URL (skill subdirectory) | `qwenaudio skill install https://github.com/o/r/tree/main/skills/x --skill x` |
| Hub skill page URL | `qwenaudio skill install https://clawhub.ai/thcjp/skills/excel-formula-tool-free --skill excel-formula-tool-free` |
| Local directory | `qwenaudio skill install ./my-skill --skill my-skill` |

For multi-skill repositories `--skill` is required (repeat it to install
several); run `--list` first to see what a source provides. Installing an
entire large catalog at once is intentionally not supported — every skill
description is injected into backend system prompts.

Skills land in each backend CLI's own user-level directory
(`~/.claude/skills/`, `~/.qwen/skills/`, `~/.openclaw/skills/`,
`~/.agents/skills/`, …), so they also work when you use those CLIs directly,
and the desktop app and CLI share the same skills.

When you switch to — or newly install — a backend that is missing previously
installed skills, the gateway backfills them synchronously at startup: a
millisecond-level local check against the skills.sh lockfile
(`~/.agents/.skill-lock.json`), and only when something is actually missing a
one-off skills.sh run (a few seconds) before the backend process starts, so
the backend always sees a complete skill set on its first scan. Failures
(for example offline) are logged and never block the voice gateway.

The pinned skills.sh version can be overridden with
`QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` (for example `skills@latest`). If a
newly added backend is not yet supported by skills.sh, contribute an agent
definition to its `src/agents.ts` — that is the official extension point.

### When skills take effect

Files are synced immediately, but each backend discovers new skills on its
own schedule:

| Backend | Discovery | New skill visible |
| --- | --- | --- |
| Claude Code, Qwen Code, Hermes, DeepSeek | Hot reload (watcher or on-demand read) | Immediately, no action needed |
| Qoder | On session start; `/skills reload` inside a native session | Next backend session |
| OpenCode, OpenClaw, Kimi Code, CodeBuddy, Codex | Snapshot at process or session start | After the backend process restarts |

If a newly installed skill is not picked up, `qwenaudio gateway restart`
restarts the backend process and always resolves it.

### Shared backend workspace

All backends now share one default working directory,
`<config-dir>/workspace`, so switching backends continues the same files
seamlessly. Per-backend overrides (for example `OPENCODE_WORKSPACE`)
still isolate a specific backend when set explicitly. Older versions used
per-backend directories under `<config-dir>/workspaces/<backend>/`; if such a
directory still contains files, the gateway logs a
`workspace.legacy_directory` notice on startup. Files are never migrated or
deleted automatically — move anything you still need into the shared
workspace manually.

## Minimal Configuration

The minimal configuration only requires real-time voice credentials:

```dotenv
DASHSCOPE_API_KEY=your-key
```

The frontend `web_search` tool returns verifiable source links, does not create
backend Agent work, and does not invoke another text model. Without explicit
configuration it uses a small, key-free Bing adapter that parses one public
search results page and is reachable in mainland China. This basic fallback is
experimental: it may be blocked, return weak results, or break with upstream
changes. Configure your own provider for reliable search. DuckDuckGo remains available by setting
`QWEN_AUDIO_WEB_SEARCH_PROVIDER=duckduckgo`.

After enabling Model Studio's Web Search MCP service, select its built-in preset
explicitly; it then reuses `DASHSCOPE_API_KEY`:

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=bailian
```

The same provider-neutral adapter can connect to another compatible MCP search
service. Custom endpoints must provide their own credentials explicitly:

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=mcp
QWEN_AUDIO_WEB_SEARCH_MCP_URL=https://example.com/mcp
QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN=your-token
QWEN_AUDIO_WEB_SEARCH_MCP_TOOL=web_search
```

Set `QWEN_AUDIO_WEB_SEARCH_PROVIDER=none` to disable frontend web search.

General chatbot tools can be connected through the frontend MCP client. Set
`QWEN_AUDIO_FRONTEND_MCP_CONFIG` to its versioned JSON file; tools must be
enabled individually and writable operations require confirmation. See
[Frontend MCP client](reference/frontend-mcp.md).

REST services with an OpenAPI 3.x document use the same tool and approval
boundary through `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG`. See
[Frontend OpenAPI tool adapter](reference/frontend-openapi.md).
To keep the assistant persona, MCP configuration, and OpenAPI configuration as
one local frontend bundle, set only `QWEN_AUDIO_FRONTEND_PROFILE`. See
[Lightweight Frontend Profiles](reference/frontend-profile.md).
WebUI and terminal clients show the normalized source links below the final
assistant answer; other clients can consume the same `messages.citations`
Gateway capability.

When you need to execute backend tasks, select a backend Agent (using OpenClaw as an example):

```dotenv
AGENT_PROTOCOL=openclaw
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

With the above configuration, OpenCode and OpenClaw can automatically download compatible
versions and configure the Bailian model, enabling one-click startup. If no backend model is
specified, the user's already installed and configured Agent is used preferentially, without
overwriting its models, providers, tools, MCPs, Skills, and authentication. Other backends
currently require users to install and configure them manually.

This is the only backend model configuration entry for qwen-audio-agent. The Gateway maps this
value to the model identifier used by the selected backend; the model ID is still defined by each
Agent and is not uniformly named by ACP. The backend's own native model environment variables can
still be read by the backend, but the Gateway does not interpret them as model override requests.

When no model is specified, the Gateway does not pass a model and does not guess a default value:
the model for a newly created Session is entirely chosen by the backend Agent based on user
configuration, and a restored Session retains its original model. The model used by a historical
Session may differ from the user's current default model; this is the Session semantics of the
backend Agent, and the Gateway does not reset it on its own.

An explicit model is applied to the coordination Session, new project Sessions, and restored
project Sessions. The Gateway discovers model options from ACP `configOptions` by
`category: model` and sets them via `session/set_config_option`; if the Agent does not provide
model configuration, the target model is not in the selectable list, the call fails, or the
returned result cannot be confirmed as effective, the current request will explicitly fail
without silently switching to another model. When `QWEN_AUDIO_AGENT_BACKEND_MODEL` is not set,
the model setting interface is not called at all.

The local identity key is automatically generated when the program first starts, saved in
`state.env` in the same configuration directory, with file permissions restricted to read and
write by the current user only.

The same directory also creates `ASSISTANT.md`, `USER.md`, and `MEMORY.md`. `ASSISTANT.md`
defines only the assistant instance's default name, personality, and expression style; `USER.md`
stores the current user's explicit long-term personalization overlay; `MEMORY.md` stores durable
facts and decisions used only for understanding and answers. All three are ordinary Markdown and direct edits
apply to the next voice session. The assistant maintains the latter two through constrained exact
edits and never changes `ASSISTANT.md` on its own. Do not store passwords, API keys, verification
codes, or tokens in them.
If you need to place user preferences elsewhere, you can set:

```dotenv
QWEN_AUDIO_AGENT_USER_MODEL_PATH=/absolute/path/to/USER.md
QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH=/absolute/path/to/ASSISTANT.md
```

In multi-user `browser` mode, each identity gets isolated Markdown documents under `users/`;
the default local user's files are never shared.

The same user directory also stores:

```text
ASSISTANT.md          # Customizable assistant name, personality, and expression style
USER.md               # Explicit long-term interaction directives for the current user
MEMORY.md             # Durable facts and decisions about the user and projects
memory-audit.jsonl    # Audit log for automatic memory (appended entry by entry, for post-hoc review only)
tasks.json            # Recovery state for backend tasks, results, and pending broadcast notifications
```

These files, like `ASSISTANT.md`, `USER.md`, and `state.env`, are only readable and writable by the current user
and are not written to the source code repository. Legacy `frontend-memory.json` content is split
into `USER.md` and `MEMORY.md` on first launch. Advanced users can override the memory location
with `QWEN_AUDIO_AGENT_MEMORY_PATH` (the old `QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH` remains
accepted) and the task location with
`QWEN_AUDIO_AGENT_TASK_STATE_PATH`.

### Automatic Memory Reconciliation

After a session ends, the Gateway uses a lightweight text model to reconcile the conversation:
missed explicit interaction directives go to `USER.md`, while stable facts and decisions go to
`MEMORY.md`. This path uses the same memory service as Realtime and never writes files directly
or modifies `ASSISTANT.md` (see
[Assistant Profile, User Preferences, and Memory](reference/memory.md) for details). Related optional configuration:

```bash
QWEN_AUDIO_MEMORY_AUTO=on         # off globally disables automatic reconciliation (default on)
QWEN_AUDIO_MEMORY_MODEL=qwen-flash  # Extraction model (default qwen-flash)
QWEN_AUDIO_MEMORY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
                                  # Any OpenAI-compatible endpoint, including local Ollama
QWEN_AUDIO_MEMORY_API_KEY=        # Defaults to reusing DASHSCOPE_API_KEY
```

When neither Key is configured (e.g., a purely local speech-to-speech frontend), automatic
reconciliation is silently disabled; explicitly requested memory is not affected.

## Selecting a Backend

`AGENT_PROTOCOL` has no default value and is also an optional configuration. When left blank,
the Gateway only provides frontend real-time voice chat; requests requiring backend execution
will return a clear error without creating tasks or guessing execution results.
You can also use `qwenaudio --backend none` to explicitly start frontend-only mode.

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

OpenCode: The Gateway interacts with it via `opencode acp` and manages the local service used
to open the native Session interface. When there is no compatible installation, it automatically
uses a fixed npm package; users do not need to separately install or start the service.
`OPENCODE_BASE_URL` names that local Session UI service; it is not a remote ACP execution
endpoint that qwen-audio-agent can attach to:

```dotenv
AGENT_PROTOCOL=opencode
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

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

### Qwen Code

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

### Kimi Code

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
launcher; see the [Backend Adapter SDK](reference/backend-adapter-sdk.md). SDK
composition does not add an `AGENT_PROTOCOL` name or let configuration files
dynamically load arbitrary code.

### Hermes

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

### CodeBuddy

CodeBuddy Code (Tencent's `@tencent-ai/codebuddy-code`) uses `codebuddy --acp`. Its ACP mode
requires account authentication; before first use, you should run `codebuddy` interactively
and complete a login via `/login`.

```dotenv
AGENT_PROTOCOL=codebuddy
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

By default, it directly uses CodeBuddy's existing model configuration. Only when
`QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicitly set will the coordination workspace generate a
project-level `.codebuddy/models.json`, reading the specified model and address via environment
variables. Advanced configuration:

```dotenv
CODEBUDDY_BIN=
CODEBUDDY_WORKSPACE=
CODEBUDDY_MODEL_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

After canceling the model override, the Gateway removes the `.codebuddy/models.json` it
generated and restores CodeBuddy's original model; user-modified files are always preserved.
When the override is enabled, changes to `QWEN_AUDIO_AGENT_BACKEND_MODEL` are automatically
synced to the system-generated file.

### Codex

Codex ([openai/codex](https://github.com/openai/codex)) connects via
[codex-acp](https://github.com/agentclientprotocol/codex-acp) maintained by the ACP project.
The launcher script preferentially binds the `codex` already installed in the user environment,
and preferentially uses the installed `codex-acp`; when the adapter is missing, it uses a fixed
version via `npx`.

```dotenv
AGENT_PROTOCOL=codex
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

By default, it reuses the user's `~/.codex`, login state, and model. The model is only
overridden when `QWEN_AUDIO_AGENT_BACKEND_MODEL` is explicitly set; `CODEX_BASE_URL` is only
used to configure a custom model service address. Neither modifies the user's configuration
file. Advanced configuration:

```dotenv
CODEX_ACP_BIN=
CODEX_ACP_PACKAGE=@agentclientprotocol/codex-acp@1.1.7
CODEX_ACP_RUNTIME=auto
CODEX_PATH=
CODEX_WORKSPACE=
CODEX_BASE_URL=
```

### Claude Code

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

### Pi

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
  `~/.config/qwaudio/workspace`, shared with the other managed backends).
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

Kimi Code, Hermes, CodeBuddy, Codex, Claude Code, and Pi all have their ACP subprocesses
directly managed by the Gateway, and do not accept `--backend-url`.

## Backend Permission Modes

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` can be set to:

- `native` (default): Permissions are determined and requested by the backend Agent itself;
  the Gateway only forwards them as-is.
- `full`: Explicitly grants the highest permission at startup; the backend can directly execute
  commands, read and write files, without per-request confirmation.

`full` currently supports OpenCode, Qoder, Qwen Code, Kimi Code, Hermes, CodeBuddy, Codex, and
Claude Code. The Gateway automatically approves permission requests initiated by these ACP
backends; in addition, Kimi Code switches to an Auto mode that does not ask again via ACP
Session configuration, Qoder and CodeBuddy CLI use `--dangerously-skip-permissions`, OpenCode
sets `permission: "allow"` in the managed process's inline configuration for both the
coordination Agent and task Agents, and Codex uses `agent-full-access` mode. Kimi Code's YOLO
mode may still ask the user, so it is not used to map `full` here.

Pi is a special case: it has no built-in sandbox or permission approval mechanism,
and its adapter pi-acp does not implement ACP `session/request_permission`. Pi
therefore always runs with the equivalent of `full` permissions no matter which
permission mode is configured — this is not "support for `full`" but the absence of
any approval step. Pi declares this through the `alwaysFullPermission` backend
capability: configuration resolution and Gateway health both normalize and display
the effective `full` mode (never the misleading `native`). Use it only in trusted
projects and trusted prompt environments.

OpenClaw's execution authorization is simultaneously constrained by exec approvals, elevated,
and execution host configurations, and cannot be safely and completely expressed by a single
unified switch; when `full` is selected, the Gateway explicitly refuses to start, requiring
separate configuration via OpenClaw's own method. The highest permission amplifies the risk of
misoperation and should only be enabled in trusted projects and trusted prompt environments.

The desktop edition, CLI, and WebUI can reuse the same Gateway, but only one active voice
entry point is allowed per user at a time. The CLI does not preempt the existing desktop voice
by default; use this when you need to explicitly take over:

```bash
qwenaudio tui --takeover
```

Only one TUI can run per user. The Gateway, desktop app, and WebUI can all reside
simultaneously; the desktop orb displays an occupied status during TUI voice takeover.

## Remote Access Security

By default, the Gateway only trusts literal loopback Host/Origin, preventing malicious web
pages from connecting to local voice and backend Agents via DNS rebinding. To access from other
devices, do not simply set `HOST=0.0.0.0` and expose the port; instead, use an HTTPS reverse
proxy with access authentication, and configure the public Origin:

```dotenv
HOST=127.0.0.1
QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com
```

The reverse proxy must:

- Complete user authentication before forwarding;
- Only accept HTTPS, and correctly forward WebSocket;
- Preserve the public `Host`;
- Forward traffic to the local `127.0.0.1:3101`.

`QWEN_AUDIO_AGENT_AUTH_SECRET` is only used to sign the local identity, not as a remote access
password. It must not be used as a substitute for reverse proxy authentication. Multiple
trusted Origins can be separated by English commas.

## Gateway Operation

A single data directory only allows one local Gateway at any time. The CLI, TUI, and WebUI
share `~/.config/qwaudio` and preferentially reuse the same instance; the desktop edition uses
a separate directory and only reuses or manages the Gateway under its own directory. Multiple
clients within the same directory can connect simultaneously, but do not each start a set of
backend Agents. The instance identity is recorded in a temporary `gateway.lock` file under the
user configuration directory; it is deleted when the Gateway exits normally, and locks left by
abnormal exits are automatically reclaimed after confirming the original process has ended. If
the existing Gateway's Realtime, backend Agent, or permission configuration is inconsistent with
the current request, startup will explicitly error rather than silently opening a random port.
Remote Gateways do not participate in the local single-instance lease.

By default, the Gateway starts and manages the selected Agent's ACP process. If the local
service port of OpenCode or OpenClaw is already occupied by another process, it will select an
idle port and will not take over or close the user's process. OpenClaw is always started as an
independent Gateway by qwen-audio-agent, using isolated runtime state and Session storage; it
can read the user's existing model and capability configuration, but does not share Sessions
with the user's persistent Gateway, nor does it reconnect to the external messaging channels
configured by the user. OpenCode's ACP process always reuses its native configuration and
Session storage; the native interface being unavailable does not affect ACP task execution.

`qwenaudio`, `qwenaudio gateway`, and `qwenaudio gateway run` all run in the foreground.
When you need it to run persistently in the background, use:

```bash
qwenaudio gateway install    # Install and immediately start the user service
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

The background service re-reads `config.env` each time it starts. After modifying configuration,
run `qwenaudio gateway restart` to apply it. Service logs are located at
`~/.config/qwaudio/logs/gateway.log`; on Linux, you can also view them via
`journalctl --user -u qwen-audio-agent-gateway`.

## Local Logs

qwen-audio-agent uses a unified local structured log, written by default to:

```text
~/.config/qwaudio/logs/
├── gateway.log   # Gateway, Realtime, ACP, and task lifecycle
├── desktop.log   # Desktop main process and embedded Gateway lifecycle
├── cli.log       # CLI command lifecycle
└── tui.log       # Lifecycle when directly starting TUI
```

The logs use a JSON Lines format with one JSON object per line, including stable `schema`,
`time`, `level`, `component`, `event`, and `pid` fields, and carrying `sessionId`, `turnId`,
`taskId`, `provider`, `backend`, `durationMs`, and other correlation information as needed. API
keys, tokens, Authorization, cookies, passwords, and secret fields are desensitized before
writing; by default, microphone audio, user transcription text, model reply text, task
objectives, and task results are not recorded.

The desktop edition can open the log directory in "Settings → Application → Logs". The default
log level is `info`; individual files rotate after reaching 10 MiB, with a total of 5 files
retained. These can be adjusted via the following environment variables:

| Setting | Default | Description |
| --- | --- | --- |
| `QWEN_AUDIO_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` |
| `QWEN_AUDIO_LOG_DIR` | `logs` under the user config directory | Custom log directory |
| `QWEN_AUDIO_LOG_MAX_BYTES` | `10485760` | Rotation threshold for a single log file |
| `QWEN_AUDIO_LOG_MAX_FILES` | `5` | Total number of current and rotated files to retain |
| `QWEN_AUDIO_LOG_FILE` | `1` | Set to `0` to disable file logging |
| `QWEN_AUDIO_LOG_CONSOLE` | `1` | Set to `0` to disable terminal log output |

Logs are only stored locally and are not automatically uploaded. Before reporting issues, check
and share relevant snippets as needed; even though the system automatically desensitizes, you
should re-confirm before sending that they do not contain local paths or business information
you do not want to be public.

The TUI, WebUI, and desktop edition only connect to the Gateway and do not directly connect
to, start, or stop any backend Agent. Core configuration in desktop settings is saved to the
user configuration file and takes effect on the next Gateway startup; the Gateway address is
validated and switched immediately.

OpenCode and OpenClaw use a consistent user environment priority order:

1. The executable explicitly specified by `OPENCODE_BIN` / `OPENCLAW_BIN`.
2. The source directory explicitly specified by `OPENCODE_SOURCE_DIR` / `OPENCLAW_SOURCE_DIR`.
3. The `opencode` / `openclaw` already installed by the user in PATH.
4. When no compatible installation is found, a fixed npm package with the current verified
   version is automatically used via `npx`.

Source directories are only used when explicitly configured by the user, without inferring
adjacent project directories. To force a particular launch method, configure:

```dotenv
# auto (default), binary, source, installed, or package
OPENCODE_RUNTIME=auto
OPENCLAW_RUNTIME=auto
```

To temporarily verify other fixed package versions or internal mirrors, you can explicitly
override the full package specifier:

```dotenv
OPENCODE_PACKAGE=opencode-ai@1.18.5
OPENCLAW_PACKAGE=openclaw@2026.6.33
```

The OpenCode ACP integration currently requires OpenCode `1.18.0` or higher. In `auto` mode,
when an older version is discovered, a fixed compatible package is used without modifying the
user's installation; when `installed` is explicitly set, it directly errors.
The minimum version can be overridden by `OPENCODE_MIN_VERSION` for validating other
compatible versions.

The OpenCode started by qwen-audio-agent inherits the user's original global configuration by
default (usually `~/.config/opencode/opencode.json`), so already installed MCPs, Skills,
permissions, models, and plugins can continue to be used. The coordination rules and
third-layer Session tools are dynamically provided by the Gateway through ACP in each request
round, without additionally installing or overwriting the OpenCode Agent.

If the user's configuration or third-party plugins conflict with qwen-audio-agent, you can
temporarily enable isolation mode for troubleshooting:

```dotenv
QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG=true
```

You can also specify a different OpenCode user configuration directory via
`QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME`. After isolation, MCPs and plugins from the
original global configuration are not automatically loaded.

## Realtime model selection

One Gateway owns one active Realtime model. The Desktop settings page can configure the model
for a locally owned Gateway, and the CLI provides the equivalent commands:

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen3.5-omni-flash-realtime
qwenaudio gateway restart
```

The exact supported IDs are:

| Model | Model input | Model output | Current client transport |
| --- | --- | --- | --- |
| `qwen3.5-omni-flash-realtime` | text, audio, image | text, audio | text, audio |
| `qwen3.5-omni-plus-realtime` | text, audio, image | text, audio | text, audio |
| `qwen-audio-3.0-realtime-plus` (default) | text, audio | text, audio | text, audio |
| `qwen-audio-3.0-realtime-flash` | text, audio | text, audio | text, audio |

All four profiles support Function Calling. Model capability is not the same as an implemented
client transport: JPEG observation frames and native video are both disabled in this release.
WebUI and TUI read the authoritative profile from Gateway health and only display it. Separate
clients cannot select conflicting models on one Gateway. A Desktop attached to a borrowed
Gateway, or a later CLI runtime using a conflicting configured model, refuses the mismatch
instead of silently changing the running service. To roll back, set the legacy ID above and
restart the Gateway.

## Advanced Settings

The following settings all have stable default values; ordinary users do not need to write
them to the configuration file:

| Setting | Default |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3101` |
| `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS` | Empty; only loopback allowed |
| `OPENCODE_WORKSPACE` | `workspaces/opencode` under the user config directory |
| `QODER_WORKSPACE` | `workspaces/qoder` under the user config directory |
| `QWEN_AUDIO_AGENT_BACKEND_MODEL` | Empty; uses the backend Agent's original model |
| `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` | `native` |
| `QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` | Empty; comma-separated opt-in environment names for generic ACP only |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` |
| `QWEN_AUDIO_REALTIME_PROVIDER` | `dashscope` |
| `QWEN_AUDIO_WEB_SEARCH_PROVIDER` | `bing`; optional `duckduckgo`, `bailian`, `mcp`, or `none` |
| `QWEN_AUDIO_WEB_SEARCH_MCP_URL` | Empty; custom Streamable HTTP endpoint used by the `mcp` provider |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN` | `DASHSCOPE_API_KEY` for explicit `bailian`; empty for custom endpoints unless set |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOOL` | `bailian_web_search` for `bailian`; otherwise `web_search` |
| `QWEN_AUDIO_FRONTEND_PROFILE` | Empty; path to a lightweight Frontend Profile JSON file |
| `QWEN_AUDIO_FRONTEND_MCP_CONFIG` | Empty; absolute path to the versioned frontend MCP JSON file |
| `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` | Empty; absolute path to the versioned frontend OpenAPI JSON config file |
| `QWEN_AUDIO_AGENT_KNOWLEDGE_DIR` | `knowledge` under the shared user data directory |
| `QWEN_AUDIO_REALTIME_VOICE` | Empty; optional Audio-family override, otherwise runtime uses `longanqian` |
| `QWEN_OMNI_REALTIME_VOICE` | Empty; optional Omni-family override, otherwise runtime uses `Ethan` |
| `SPEECH_TO_SPEECH_REALTIME_URL` | `ws://127.0.0.1:8765/v1/realtime` |
| `SPEECH_TO_SPEECH_AUTH_TOKEN` | Empty; only for proxies with Bearer authentication |
| `QWEN_AUDIO_AGENT_IDENTITY_MODE` | `personal` |
| `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE` | `half` |
| `AGENT_TIMEOUT_MS` | `300000` |

The macOS TUI CoreAudio helper is compiled by default to
`~/Library/Caches/qwaudio/tui/macos-voice-io`, requiring no additional configuration. It
continuously records audio during playback, and only supports voice interruption.
The Linux and Windows minimal TUI uses the bundled Python audio bridge with
`sounddevice`/PortAudio half-duplex; during reply playback the microphone is paused, only
supporting manual interruption via the `x` key, and resumes after playback ends or is manually
interrupted.

On Linux and Windows, you can explicitly enable PortAudio full-duplex via
`qwenaudio tui --audio-mode full` or by setting `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE=full`. This
mode has no echo cancellation and only supports direct speech interruption; wearing headphones
is recommended to avoid speaker echo triggering false recognition or false interruption.
macOS always uses CoreAudio AEC full-duplex and is not affected by this option.

If PortAudio full-duplex persistently reports input overflow, output underflow, or device
errors, please exit the TUI and switch to `qwenaudio tui --audio-mode half`. Different
Linux/Windows sound cards and Bluetooth headsets have varying levels of support for
simultaneous input and output streams with different sampling rates; half-duplex is the
compatibility fallback.

Runtime parameters such as task status, notification retry, memory capacity, and retention
time also use built-in default values. Overriding is only recommended when explicitly
performing capacity planning or fault diagnosis.
