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
memory documents (`USER.md`, `MEMORY.md`, `ASSISTANT.md`), frontend notes, and the shared agent
`workspace/` — live in the CLI's user data directory (`~/.config/qwaudio`, overridable via
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

## Minimal Configuration

The minimal configuration only requires real-time voice credentials:

```dotenv
DASHSCOPE_API_KEY=your-key
```

The frontend `web_search` tool returns verifiable source links, does not create
backend Agent work, and does not invoke another text model. Without explicit
configuration it uses a small, key-free 360 search adapter that parses one
public search results page and is reachable in mainland China. This basic
fallback is experimental: it may be blocked, return weak results, or break
with upstream changes. Configure your own provider for reliable search.

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

This is qwen-audio-agent's only backend Session model override entry. The model ID is an opaque
value advertised by the backend through ACP; the Gateway neither guesses nor rewrites it. Native
model environment variables may still be read by the backend, but the Gateway does not interpret
them as Session model override requests. One-click OpenCode/OpenClaw provisioning uses the same
value to initialize an isolated Bailian configuration before startup; that is deployment, not an
ACP Session override.

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
without silently switching to another model. The Gateway does not emulate a Session override with
`session/set_model`, private backend RPCs, process arguments, or generated configuration files.
When `QWEN_AUDIO_AGENT_BACKEND_MODEL` is not set, the model setting interface is not called at all.

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
[Long-Term Memory](reference/memory.md) for details). Related optional configuration:

```bash
QWEN_AUDIO_MEMORY_AUTO=on         # off globally disables automatic reconciliation (default on)
QWEN_AUDIO_MEMORY_MODEL=qwen-flash  # Extraction model (default qwen-flash)
QWEN_AUDIO_MEMORY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
                                  # Any OpenAI-compatible endpoint, including local Ollama
QWEN_AUDIO_MEMORY_API_KEY=        # Defaults to reusing DASHSCOPE_API_KEY
```

When neither Key is configured (e.g., a purely local speech-to-speech frontend), automatic
reconciliation is silently disabled; explicitly requested memory is not affected.


## Read next

- [Frontend Configuration](configuration/frontend.md) — realtime credentials,
  endpoint, and model selection
- [Backend Configuration](configuration/backend.md) — backend setup check,
  one-click install, skill management, per-backend settings, permission modes
- [Advanced Settings](configuration/advanced.md) — remote access security,
  gateway operation, local logs, and the full advanced table
