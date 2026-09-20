# Quickstart

Complete one conversation first, then add a backend, tools, or remote access. Desktop does not require a CLI installation.

| How you want to use it | Next step |
| --- | --- |
| Desktop app | [Download and open Desktop](../desktop/overview.md#first-run), then configure it in Settings. |
| Terminal or browser | Start a Gateway below, then connect TUI or WebUI. |
| Phone or another computer | Start a Gateway on a computer or server, then [generate a connection code](../operations/remote-access.md). |
| Custom client or adapter | Read the [extension overview](../extensions.md). |

## Command-line quickstart

If not yet installed, see [Install & Update](install.md).

### 1. Create configuration

```bash
qwenaudio config
```

Open the reported `config.env` file. Its default location is `~/.config/qwaudio/config.env`.

### 2. Add credentials

Start in frontend-only mode to verify voice conversation:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
AGENT_PROTOCOL=none
```

[Get a DashScope API Key](install.md#obtain-a-dashscope-api-key). For another cloud or local service, replace these settings using the [voice frontend guide](../configuration/frontend.md).

### 3. Start the Gateway

```bash
qwenaudio
```

Keep this terminal running. In another terminal, open the browser client:

```bash
qwenaudio webui
```

Or use the terminal client:

```bash
qwenaudio tui
```

See the [TUI guide](tui.md) for audio dependencies and platform differences.

## Verify the first conversation

1. Confirm that the client shows the Gateway and voice frontend as connected.
2. Allow microphone access, enable input, and say “Hello.”
3. Check that you see a transcript and hear a reply.

For missing audio or connection failures, see [Troubleshooting](../operations/troubleshooting.md). Each user has one active client per Gateway; taking over from a new client disconnects the previous one.

## Add a Backend Agent

A backend operates the computer, writes code, and performs other work. Install and configure a [supported backend](../backends/overview.md), such as Qwen Code, then change:

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

Leave the backend model empty to use the Agent's configuration. Stop and restart the Gateway, then ask “Check this computer's memory capacity” and inspect the work card and result.

Without an existing backend, you can use [managed OpenCode / OpenClaw initialization](../configuration/backend.md#model-selection). An unset `AGENT_PROTOCOL` or `AGENT_PROTOCOL=none` does not start a backend; chat and enabled frontend tools still work. Use `qwenaudio --backend none` for a temporary override.

## Next steps

- [How It Fits Together](concepts.md): clients, Gateway, frontend, and backend.
- [Conversation & Attachments](../guides/conversation.md): text, speech, images, and files.
- [Work & Permissions](../guides/tasks.md): status, follow-ups, cancellation, and approval.
- [Run the Gateway](../operations/gateway.md): exit, restart, and background services.
