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

Default locations are below. CLI and Desktop are different entry points to the same assistant,
but can run independent Gateways.

| Data | CLI | Desktop |
| --- | --- | --- |
| Configuration, identity, memory, notes, shared workspace | `~/.config/qwaudio` | Shared with CLI |
| Gateway lock, task state, sessions, logs | `~/.config/qwaudio` | System application data directory |
| Pet skins and window state | Not applicable | System application data directory |

Desktop application data directories:

- macOS: `~/Library/Application Support/Qwen Audio Agent`
- Windows: `%APPDATA%/Qwen Audio Agent`
- Linux: `~/.config/Qwen Audio Agent`

The shared directory contains `config.env` for settings, `ASSISTANT.md` for the default persona,
`USER.md` for preferences, and `MEMORY.md` for facts. The automatically generated `state.env`
contains local identity secrets; do not share it. See [Personalization](reference/personalization.md)
and [Memory](reference/memory.md).

Advanced users can set `QWAUDIO_DATA_DIR` for shared assets. `QWAUDIO_CONFIG_DIR` explicitly
overrides the runtime directory and also isolates assets unless a separate data directory is set.
`XDG_CONFIG_HOME` affects the CLI default. Overrides change the default isolation; do not share task
or identity files between unrelated instances.

Upgrades only backfill missing shared assets from older Desktop installations. Existing files on
both sides are not automatically overwritten or merged. Stop applications using these directories
before backing up configuration and data. Log rotation is not conversation-history management.

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
