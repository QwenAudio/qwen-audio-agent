# Advanced Settings

## Remote Access Security

Connection methods, Tailnet, HTTPS reverse proxies, and pairing commands are covered in
[Remote Connections](../operations/remote-access.md).

## Gateway Operation

For foreground runs, persistent services, Desktop's embedded Gateway, and restarts,
see [Run the Gateway](../operations/gateway.md).

## Local Logs

qwen-audio-agent uses unified structured logs, stored by their respective owners:

- CLI-hosted Gateway: `~/.config/qwaudio/state/logs/`.
- Desktop-hosted Gateway: `~/.config/qwaudio/state/desktop/logs/`.
- Desktop Client: `logs/` under its [application data directory](../configuration.md#configuration-and-data-directories).
- TUI: `~/.config/qwaudio/tui/logs/`.

The file responsibilities below do not mean all files share the same directory:

```text
logs/                       # Root depends on the run mode
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

For foreground-tool latency analysis, correlate `realtime.provider.speech_stopped`,
`realtime.tool_call.received`, `realtime.tool_call.result_ready`, and
`realtime.playback.started` by `sessionId` and `turnId`; failed calls use
`realtime.tool_call.failed`. The first event is the Realtime provider's endpoint decision,
not the user's physical last speech sample. Measuring the earlier acoustic-to-endpoint interval
requires a Client-side capture timestamp or a controlled real-time PCM replay.

The desktop edition can open the log directory in "Settings → App → Logs". The default
log level is `info`; individual files rotate after reaching 10 MiB, with a total of 5 files
retained. These can be adjusted via the following environment variables:

| Setting | Default | Description |
| --- | --- | --- |
| `QWEN_AUDIO_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` |
| `QWEN_AUDIO_LOG_DIR` | `logs` under the instance state directory | Custom log directory |
| `QWEN_AUDIO_LOG_MAX_BYTES` | `10485760` | Rotation threshold for a single log file |
| `QWEN_AUDIO_LOG_MAX_FILES` | `5` | Total number of current and rotated files to retain |
| `QWEN_AUDIO_LOG_FILE` | `1` | Set to `0` to disable file logging |
| `QWEN_AUDIO_LOG_CONSOLE` | `1` | Set to `0` to disable terminal log output |

Logs are only stored locally and are not automatically uploaded. Before reporting issues, check
and share relevant snippets as needed; even though the system automatically desensitizes, you
should re-confirm before sending that they do not contain local paths or business information
you do not want to be public.

### Read-only diagnostics

For common connection, audio, and tool issues, start with [Troubleshooting](../operations/troubleshooting.md).

```bash
qwenaudio doctor
qwenaudio doctor --json
qwenaudio doctor --turn <turnId>
```

Check configuration, Gateway, voice frontend and MCP connections, backend readiness, and session files
without starting a model, backend Agent, or microphone, changing configuration, or repairing files.
Populated configuration does not prove that a key has remaining quota; without an active voice session,
the report explicitly indicates that the connection is unverified. Use `--url https://<gateway>` for
remote checks and `QWEN_AUDIO_GATEWAY_CLIENT_TOKEN` for credentials. Local files are not used to infer
remote configuration.

`--turn` assembles a timeline from existing log records matching `turnId`, showing identifiers and
timing only, without conversation text, tool arguments, or results. It reads up to 2 MiB from each of
the 5 most recent Gateway logs and returns at most 500 events. Rotation, missing instrumentation, or
these limits can make the timeline incomplete. Run it on the Gateway host to inspect a remote timeline.

Session files are separate from rotating logs: they retain recoverable history and are not deleted by
log rotation. Diagnostics inspect up to 1,000 session files and 64 MiB in total, skip files over 8 MiB,
and mark uninspected data. A partial final record left by an abnormal exit is reported as recoverable
and repaired the next time that session is opened for writing. Corrupt committed records are never
silently deleted.

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
available Session tools are provided through the Gateway's backend integration,
without additionally installing or overwriting the OpenCode Agent.

If the user's configuration or third-party plugins conflict with qwen-audio-agent, you can
temporarily enable isolation mode for troubleshooting:

```dotenv
QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG=true
```

You can also specify a different OpenCode user configuration directory via
`QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME`. After isolation, MCPs and plugins from the
original global configuration are not automatically loaded.


## Advanced Settings

The following settings all have stable default values; ordinary users do not need to write
them to the configuration file:

| Setting | Default |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3101` |
| `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS` | Empty; only loopback allowed |
| `QWEN_AUDIO_GATEWAY_LAN` | Empty; set to `1` to listen on LAN (`0.0.0.0`) |
| `QWEN_AUDIO_GATEWAY_LAN_HOST` | Auto-selected physical IPv4; optional explicit LAN endpoint host |
| `QWEN_AUDIO_GATEWAY_TAILNET` | Empty; set to `1` to use system Tailscale Serve |
| `QWEN_AUDIO_TAILSCALE_BINARY` | Auto-detected; optional absolute path to the system Tailscale CLI |
| `OPENCODE_WORKSPACE` | `workspace` under the shared data directory |
| `QODER_WORKSPACE` | `workspace` under the shared data directory |
| `QWEN_AUDIO_AGENT_BACKEND_MODEL` | Empty; explicit values override Sessions only through standard ACP, except managed OpenCode/OpenClaw provisioning |
| `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` | `native` |
| `QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` | Empty; comma-separated opt-in environment names for generic ACP only |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` |
| `QWEN_AUDIO_REALTIME_PROVIDER` | `dashscope` |
| `QWEN_AUDIO_WEB_SEARCH_PROVIDER` | `so360`; optional `bailian`, `bing`, `mcp`, or `none` |
| `QWEN_AUDIO_WEB_SEARCH_MCP_URL` | Empty; custom Streamable HTTP endpoint used by the `mcp` provider |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN` | `DASHSCOPE_API_KEY` for explicit `bailian`; empty for custom endpoints unless set |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOOL` | `bailian_web_search` for `bailian`; otherwise `web_search` |
| `QWEN_AUDIO_SCHEDULE_TOOL_ENABLED` | `true`; set to `false` to hide `schedule_reminder` |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | `true`; set to `false` to hide `web_search` and `fetch_url` from the frontend Agent |
| `QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED` | `true`; set to `false` to hide `knowledge` |
| `QWEN_AUDIO_NOTES_TOOL_ENABLED` | `true`; set to `false` to hide `notes` |
| `QWEN_AUDIO_RECALL_TOOL_ENABLED` | `true`; set to `false` to hide `recall` |
| `QWEN_AUDIO_FRONTEND_PROFILE` | Empty; path to a lightweight Frontend Profile JSON file |
| `QWEN_AUDIO_FRONTEND_MCP_CONFIG` | Empty; absolute path to the versioned frontend MCP JSON file |
| `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` | Empty; absolute path to the versioned frontend OpenAPI JSON config file |
| `QWEN_AUDIO_REALTIME_VOICE` | Empty; optional Audio-family override, otherwise runtime uses `longanqian` |
| `QWEN_OMNI_REALTIME_VOICE` | Empty; optional Omni-family override, otherwise runtime uses `Ethan` |
| `SPEECH_TO_SPEECH_REALTIME_URL` | `ws://127.0.0.1:8765/v1/realtime` |
| `SPEECH_TO_SPEECH_AUTH_TOKEN` | Empty; only for proxies with Bearer authentication |
| `MINICPM_O_REALTIME_URL` | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |
| `MINICPM_O_AUTH_TOKEN` | Empty; only for proxies with Bearer authentication |
| `QWEN_AUDIO_AGENT_IDENTITY_MODE` | `personal` |
| `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE` | `half` |
| `AGENT_TIMEOUT_MS` | `300000`; timeout for ACP connection initialization and bounded control requests, not active Agent turns |

The macOS TUI CoreAudio helper is compiled by default to
`~/Library/Caches/qwaudio/tui/macos-voice-io`, requiring no additional configuration. It
continuously records audio during playback, and only supports voice interruption.
The Linux and Windows minimal TUI uses the bundled Python audio bridge with
`sounddevice`/PortAudio half-duplex; during reply playback the microphone is paused, only
supporting manual interruption with `/interrupt`, and resumes after playback ends or is manually
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
