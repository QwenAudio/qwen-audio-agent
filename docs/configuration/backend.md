# Backend Configuration

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
qwenaudio install minimax
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

## Selecting a Backend

`AGENT_PROTOCOL` has no default value and is also an optional configuration. When left blank,
the Gateway does not start a Backend Agent; frontend chat and enabled tools remain available; requests requiring backend execution
will return a clear error without creating tasks or guessing execution results.
You can also use `qwenaudio --backend none` to explicitly start frontend-only mode.

## Model Selection

Leave the backend model empty to use native defaults. Only an explicit value requests an override:

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

When unset, the Gateway neither sends nor guesses a model and never calls the setting interface.
The backend chooses a model for new Sessions; restored Sessions keep their original models.
An explicit value applies to the coordinator and new or restored project Sessions.

Overrides only use `category: model` options in standard ACP `configOptions` and
`session/set_config_option`. Unsupported settings, unavailable values, failed calls, or unverified
results fail the request explicitly. Private RPCs and startup arguments are not used to simulate
an override. Use model IDs as advertised by the backend.

OpenCode / OpenClaw also support managed setup: a `DASHSCOPE_API_KEY` and backend model can
initialize a Bailian configuration for an owned instance before startup. This deployment step
does not mean every ACP backend supports model overrides. With other installed and configured
Agents, simply select the backend and normally leave the model empty.

## Backend-Specific Settings

<a id="openclaw"></a>
<a id="opencode"></a>
<a id="qoder"></a>
<a id="qwen-code"></a>
<a id="minimax-code"></a>
<a id="kimi-code"></a>
<a id="hermes"></a>
<a id="codebuddy"></a>
<a id="codex"></a>
<a id="claude-code"></a>
<a id="pi"></a>

[OpenClaw](../backends/configuration.md#openclaw) · [OpenCode](../backends/configuration.md#opencode) · [Qoder](../backends/configuration.md#qoder) · [Qwen Code](../backends/configuration.md#qwen-code) · [MiniMax Code](../backends/configuration.md#minimax-code) · [Kimi Code](../backends/configuration.md#kimi-code) · [Hermes](../backends/configuration.md#hermes) · [CodeBuddy](../backends/configuration.md#codebuddy) · [Codex](../backends/configuration.md#codex) · [Claude Code](../backends/configuration.md#claude-code) · [Pi](../backends/configuration.md#pi)

## Skill Management

Skills install only into backends. See [Backend Skills](../guides/skills.md) for commands and locations.

### When skills take effect

See [skill discovery and loading](../guides/skills.md#when-skills-take-effect).

### Shared backend workspace

See [shared backend workspace](../guides/skills.md#shared-backend-workspace).

## Backend Permission Modes

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` can be set to:

- `native` (default): Permissions are determined and requested by the backend Agent itself;
  the Gateway only forwards them as-is.
- `full`: Explicitly grants the highest permission at startup; the backend can directly execute
  commands, read and write files, without per-request confirmation.

`full` currently supports OpenCode, Qoder, Qwen Code, MiniMax Code, Kimi Code, Hermes, CodeBuddy, Codex, and
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
