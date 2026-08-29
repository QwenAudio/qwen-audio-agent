# Advanced Settings

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

The desktop edition can open the log directory in "Settings → App → Logs". The default
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


## Advanced Settings

The following settings all have stable default values; ordinary users do not need to write
them to the configuration file:

| Setting | Default |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3101` |
| `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS` | Empty; only loopback allowed |
| `OPENCODE_WORKSPACE` | `workspaces/opencode` under the user config directory |
| `QODER_WORKSPACE` | `workspaces/qoder` under the user config directory |
| `QWEN_AUDIO_AGENT_BACKEND_MODEL` | Empty; explicit values override Sessions only through standard ACP, except managed OpenCode/OpenClaw provisioning |
| `QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` | `native` |
| `QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` | Empty; comma-separated opt-in environment names for generic ACP only |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` |
| `QWEN_AUDIO_REALTIME_PROVIDER` | `dashscope` |
| `QWEN_AUDIO_WEB_SEARCH_PROVIDER` | `so360`; optional `bailian`, `bing`, `mcp`, or `none` |
| `QWEN_AUDIO_WEB_SEARCH_MCP_URL` | Empty; custom Streamable HTTP endpoint used by the `mcp` provider |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN` | `DASHSCOPE_API_KEY` for explicit `bailian`; empty for custom endpoints unless set |
| `QWEN_AUDIO_WEB_SEARCH_MCP_TOOL` | `bailian_web_search` for `bailian`; otherwise `web_search` |
| `QWEN_AUDIO_FRONTEND_PROFILE` | Empty; path to a lightweight Frontend Profile JSON file |
| `QWEN_AUDIO_FRONTEND_MCP_CONFIG` | Empty; absolute path to the versioned frontend MCP JSON file |
| `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` | Empty; absolute path to the versioned frontend OpenAPI JSON config file |
| `QWEN_AUDIO_REALTIME_VOICE` | Empty; optional Audio-family override, otherwise runtime uses `longanqian` |
| `QWEN_OMNI_REALTIME_VOICE` | Empty; optional Omni-family override, otherwise runtime uses `Ethan` |
| `SPEECH_TO_SPEECH_REALTIME_URL` | `ws://127.0.0.1:8765/v1/realtime` |
| `SPEECH_TO_SPEECH_AUTH_TOKEN` | Empty; only for proxies with Bearer authentication |
| `QWEN_AUDIO_AGENT_IDENTITY_MODE` | `personal` |
| `QWEN_AUDIO_AGENT_TUI_AUDIO_MODE` | `half` |
| `AGENT_TIMEOUT_MS` | `300000`; timeout for ACP connection initialization and bounded control requests, not active Agent turns |

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
