# Logs & Diagnostics

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

## Other Runtime Settings

Network, backend startup, audio modes, and tool switches are documented at their respective boundaries:

| Setting | Guide |
| --- | --- |
| Listen address, Tailnet, pairing, and access control | [Remote Connections](../operations/remote-access.md) |
| Backend runtime source, model, permissions, and workspace | [Common Settings](backend.md), [Backend-Specific Settings](../backends/configuration.md) |
| Voice frontend, model, and voice | [Frontend Configuration](frontend.md) |
| Terminal half/full duplex | [TUI](../getting-started/tui.md) |
| Search, knowledge, memory, and reminders | [Feature Guides](../guides/conversation.md), [Configuration Overview](../configuration.md) |

`AGENT_TIMEOUT_MS` defaults to `300000` and bounds ACP initialization and control requests, not active Agent turns. You do not need to increase it just for long-running work.
