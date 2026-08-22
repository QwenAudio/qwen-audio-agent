# Backend Agent

The Backend Agent handles tasks that require tools, file operations, or sustained processing. When the frontend voice LLM determines that a request needs execution, it delegates the goal to the Backend Agent for asynchronous execution; once the result is ready, it naturally returns to the current conversation.

## Supported Agents

| Backend Agent | Integration Method | Setup Requirements | Skills | Recommendation |
| --- | --- | --- | --- | --- |
| None | N/A | Frontend-only mode, no configuration needed | — | ★★★★★ |
| OpenCode | Native ACP | Supports one-click install and Bailian configuration | `~/.config/opencode/skills/` | ★★★★★ |
| OpenClaw | Built-in ACP bridge | Supports one-click install and Bailian configuration | `~/.openclaw/skills/` | ★★★★★ |
| Qoder | Native ACP | Supports one-click install, requires user configuration | `~/.qoder/skills/` | ★★★★★ |
| Qwen Code | Native ACP | Supports one-click install, requires user configuration | `~/.qwen/skills/` | ★★★★☆ |
| Kimi Code | Native ACP | Supports one-click install, requires user configuration | `~/.agents/skills/` | ★★★★★ |
| Hermes | Native ACP | Supports one-click install, requires user configuration | `~/.hermes/skills/` | ★★★★☆ |
| CodeBuddy | Native ACP | Supports one-click install, requires user configuration | `~/.codebuddy/skills/` | ★★★★☆ |
| Codex | External ACP adapter | Supports one-click install of both the core and adapter, requires user configuration | `~/.codex/skills/` | ★★★★☆ |
| Claude Code | External ACP adapter | Supports one-click install of both the core and adapter, requires user configuration | `~/.claude/skills/` | ★★★★☆ |
| DeepSeek | Native ACP | Supports one-click install, requires a DeepSeek API key | `~/.agents/skills/` | ★★★★☆ |
| Pi | External ACP adapter | Supports one-click install of both the core and adapter, requires user configuration | `~/.pi/agent/skills/` | ★★★★☆ |

Skills install once through `qwenaudio skill install` (a branded entry point
for the standard skills.sh installer) and land in every backend's user-level
directory above automatically. See
[Skill Management](../configuration.md#skill-management).

The recommendation rating reflects the current integration completeness, compatibility, and extent of real-world verification: five stars indicates a fully tested and recommended integration, while four stars indicates ongoing development or incomplete verification of the same scope.

## One-Click Install

Uninstalled backend agents can be installed locally with a unified command:

```bash
qwenaudio install codex
qwenaudio install deepseek
```

Before installation, a detection step runs to **only fill in missing components**: native ACP backends are ready to use once installed; if the core is missing, the core is installed; if the core is already installed and only the ACP adapter is missing, only the adapter is installed; if everything is ready, a prompt confirms availability. In the desktop settings page's "Backend Agent" list, an "Install" button appears at the end of rows for uninstalled backends that support one-click install, using the same installation logic as the CLI.

DeepSeek Harness is currently a Developer Preview. This initial integration
supports voice-triggered tasks, permission decisions, cancellation of the current
run, and final-result delivery. Its ACP endpoint does not yet expose historical
Session resume, Gateway MCP injection, or fine-grained tool progress. After
installation, run `dsh web` and configure the API key in DeepSeek's model
settings; `DEEPSEEK_API_KEY` remains available as a per-run override. Optionally
set `DEEPSEEK_HARNESS_MODEL` to
`deepseek-v4-pro` (default) or `deepseek-v4-flash`.

View currently available backend agents:

```bash
qwenaudio setup
```

This command only checks — it does not install, download, or verify credentials. To check only a specific backend or get machine-readable results:

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

## Choosing a Backend

`AGENT_PROTOCOL` is an optional configuration. When left empty, the Gateway runs in frontend-only mode, and real-time voice chat remains available; requests requiring backend execution will return a clear explanation without creating a task or guessing results. You can also use `qwenaudio --backend none` on the command line to explicitly start in frontend-only mode.

```dotenv
AGENT_PROTOCOL=openclaw
```

OpenCode and OpenClaw support automatic download and installation; after configuring `DASHSCOPE_API_KEY` and `QWEN_AUDIO_AGENT_BACKEND_MODEL`, they can automatically connect to Bailian models. Other backends require prior installation and native configuration; qwen-audio-agent will reuse their user-level models, tools, MCPs, Skills, and authentication.

To use other agents that support ACP stdio:

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent
ACP_ARGS=["--acp"]
```

The command, arguments, display name, and working directory can be configured via `ACP_COMMAND`, `ACP_ARGS`, `ACP_LABEL`, and `ACP_WORKSPACE` respectively. The generic ACP entry does not provide one-click install; please install it yourself.

## Permission Modes

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` can be set to:

- `native` (default): Permissions are determined and prompted by the backend agent itself; the Gateway only forwards requests as-is.
- `full`: Grants the highest permissions at startup, allowing the backend to directly execute commands, read and write files without per-action confirmation.

`full` currently supports OpenCode, Qoder, Qwen Code, Kimi Code, Hermes, CodeBuddy, Codex, and Claude Code; the Gateway will automatically approve permission requests from these backends. OpenClaw's execution authorization is constrained by exec approvals, elevated, and other configuration settings, and cannot be expressed via a single toggle — when `full` is selected, the Gateway will explicitly refuse to start. The highest permissions amplify the risk of accidental operations and should only be enabled in trusted projects.

Pi is a special case: it has no built-in sandbox or permission approval mechanism, and its adapter pi-acp does not implement ACP `session/request_permission`. Pi therefore always runs with the equivalent of `full` permissions regardless of the configured mode — there is no approval step at all, and no permission confirmation appears in the voice session. Use it only in trusted projects and trusted prompt environments.

The current community adapter does not wire ACP `mcpServers` into Pi, so Gateway
Session tools and independent third-layer delegation are unavailable for this backend.
Pi handles work in the current Session with its own tools.

## Backend Service

To keep your personal assistant online long-term, you can install it as a user-level background service:

```bash
qwenaudio gateway install    # Install and start immediately
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

The background service re-reads `config.env` on every startup; after modifying configuration, run `gateway restart` to apply changes.

For advanced configuration of each backend (executable paths, working directories, model overrides, etc.), see
[Configuration Guide](../configuration.md).
