# Configuration Overview

Usually you only need voice-frontend credentials. Select a Backend Agent when you want the
assistant to take action. Desktop exposes common settings in its Settings page; CLI users can find
the configuration file with:

```bash
qwenaudio config
```

The command shows the exact path and creates a template if missing. Never commit API keys,
tokens, or local identity secrets.

## Minimal Configuration

For the default voice frontend:

```dotenv
DASHSCOPE_API_KEY=your-key
```

If your Backend Agent is already installed and configured, simply select it. For Qwen Code:

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

An empty backend model preserves the Agent's own configuration; setting it explicitly requests an
override. Leave the backend unset or choose `AGENT_PROTOCOL=none` if not needed. Frontend chat
and enabled tools remain available. For OpenCode / OpenClaw managed setup and model-override
constraints, see [backend settings](configuration/backend.md).

## Configuration Priority

```text
CLI parameters > process environment variables > .env.local > .env > user configuration file > built-in defaults
```

When running from source, the repository's `.env.local` or `.env` may override the user file.
If changes seem ineffective, check the actual file, process environment, and Gateway you are connected to.

See [Run the Gateway](operations/gateway.md#applying-configuration-changes) to apply changes:
restart foreground runs, use `gateway restart` for installed services, or click Apply in Desktop.

## Configuration and Data Directories

The product root defaults to `~/.config/qwaudio`. Gateway and TUI manage their own files
within it; ownership does not require a separate top-level directory for every process:

| Content | Default path, relative to root | Desktop and CLI |
| --- | --- | --- |
| Settings, default persona, local identity | `config.env`, `ASSISTANT.md`, `identity.env` | Shared |
| Preferences, memory, notes | `data/USER.md`, `data/MEMORY.md`, `data/frontend-notes.json` | Shared |
| Default backend workspace | `data/workspace/` | Shared; separately configurable |
| Imported documents and index | `data/knowledge/` | Shared |
| Tasks, sessions, logs, locks, managed backend state | `state/` | Per Gateway |
| Rebuildable Gateway cache | `cache/` | Disposable |
| TUI connection profiles, credentials, instance locks and logs | `tui/` | Terminal Client only |

CLI-hosted Gateways default to `state/`; desktop-hosted Gateways use `state/desktop/`.
They share configuration, memory and workspace, but keep tasks, sessions and runtime logs separate.
Native backend sessions belong to the backend, not to the workspace's project files.

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `QWAUDIO_CONFIG_DIR` | Product root; set before startup | `$XDG_CONFIG_HOME/qwaudio`, or `~/.config/qwaudio` |
| `QWAUDIO_DATA_DIR` | Shared user data | `<config-dir>/data` |
| `QWAUDIO_STATE_DIR` | Current Gateway's persistent state | CLI: `<config-dir>/state`; desktop-hosted: `<config-dir>/state/desktop` |
| `QWAUDIO_CACHE_DIR` | Rebuildable cache | `<config-dir>/cache` |
| `QWAUDIO_WORKSPACE` | Default workspace for all backends | `<data-dir>/workspace` |

Except for the product root itself, the Gateway directory options above can also be set in `config.env`.
Prefer absolute paths. A backend-specific workspace, such as `QODER_WORKSPACE`, takes precedence.
Independent Gateways must not share state directories. State is not cache: deleting it loses task
and session history. Keep `identity.env` private; back up configuration, data and any needed state.

Startup does not discover, merge or migrate old layouts. To retain existing projects and memory,
explicitly configure their locations or arrange files while stopped. Old files are never deleted automatically.

### Client Directories

Desktop uses the platform application data directory:

- macOS: `~/Library/Application Support/Qwen Audio Agent`
- Windows: `%APPDATA%/Qwen Audio Agent`
- Linux: `$XDG_CONFIG_HOME/Qwen Audio Agent`, defaulting to `~/.config/Qwen Audio Agent`

`settings.env` stores the Gateway connection address, language, appearance and wake preferences;
`ui-state.json` stores window placement and client session identifiers. Connection credentials,
`skins/`, `cache/` (including wake-word models) and `logs/` also belong to the client.
Electron manages browser storage. Voice service and backend settings from the same settings page
are still written to the Gateway's `config.env`.

TUI connection profiles and credentials live in `<config-dir>/tui/`, defaulting to
`~/.config/qwaudio/tui/`, alongside instance locks and diagnostic logs. The CLI's
`connect`, `disconnect` and `tui` commands manage these files; Gateway never reads or writes them.

Changing `QWAUDIO_CONFIG_DIR` also relocates TUI state. Changing Gateway-only
`QWAUDIO_DATA_DIR`, `QWAUDIO_STATE_DIR` or `QWAUDIO_CACHE_DIR` does not.
Set `QWAUDIO_TUI_DIR` before startup only when a separate location is needed.
None of these variables relocate the Desktop application directory.
WebUI authentication, language and session identifiers use browser cookies and local storage.

## Configure by Need

| I want to configure… | Documentation |
| --- | --- |
| Voice models, service addresses, credentials | [Voice frontend](configuration/frontend.md) |
| Backend selection, installation, models, permissions | [Backend settings](configuration/backend.md) |
| Web search | [Search services](guides/web-search.md) |
| Documents and knowledge retrieval | [Knowledge library](guides/knowledge.md) |
| Persona, preferences, automatic memory | [Personalization](reference/personalization.md), [Memory](reference/memory.md) |
| Additional frontend tools | [MCP](reference/frontend-mcp.md), [OpenAPI](reference/frontend-openapi.md) |
| A bundle of persona and tool settings | [Frontend Profile](reference/frontend-profile.md) |
| Remote devices, persistent services | [Remote connections](operations/remote-access.md), [Gateway](operations/gateway.md) |
| Logging and other optional parameters | [Advanced settings](configuration/advanced.md) |

## Read Next

If something is not working, start with [Troubleshooting](operations/troubleshooting.md).
