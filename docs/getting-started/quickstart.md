# Quickstart

Choose how you want to use the assistant. Desktop does not require the CLI installation steps.

| I want to… | Start here |
| --- | --- |
| Open an app and talk | [Desktop](../desktop/overview.md#first-run): install, configure, and start talking. |
| Use a terminal or browser | Follow the command-line steps below, then connect TUI or WebUI. |
| Connect from a phone or another computer | [Remote connections](../operations/remote-access.md): the Gateway runs on a computer or server. |
| Build a client or adapter | [Developer extension overview](../extensions.md). |

## Command-line Quickstart

If the CLI is not installed yet, start with [Installation](install.md#one-line-install).

### 1. Create Configuration

```bash
qwenaudio config
```

The command will display the configuration file path and create a `config.env` template with comments.

### 2. Fill in Configuration

The minimal configuration only requires a DashScope API Key:

```dotenv
DASHSCOPE_API_KEY=your-key
```

For backend work, select an Agent you have already installed and configured (Qwen Code below). The backend model is optional:

```dotenv
DASHSCOPE_API_KEY=your-key
# Voice frontend model: flash for lower latency and cost savings, plus (default) for better quality
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# Backend agent: leave empty or set to none to start in frontend-only mode
AGENT_PROTOCOL=qwen
# Backend model: explicit values use standard ACP; empty reuses Agent config
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

Without an existing backend, see [OpenCode / OpenClaw managed setup](../configuration/backend.md#model-selection).

> The default uses the DashScope real-time voice frontend; you can also switch to [speech-to-speech](../voice-frontends/speech-to-speech.md). An all-local model pipeline does not require a cloud API Key.

### 3. Start

Start the Gateway in one terminal:

```bash
qwenaudio
```

Open another terminal and start the TUI:

```bash
qwenaudio tui
```

You can also use the browser interface (default `http://127.0.0.1:3101`):

```bash
qwenaudio webui
```

## Verify the Setup

Allow microphone access and say “Hello”. Confirm that a transcript appears and you hear a reply.
With a configured backend, try “Check this computer’s memory capacity” and follow its work card
and result. If there is no audio or a connection error, see [Troubleshooting](../operations/troubleshooting.md).

A user can have only one active client on a Gateway. Another client can take over after
confirmation, disconnecting the previous one. Press `Ctrl-C` to end a foreground terminal run.

## Frontend-Only Mode

When `AGENT_PROTOCOL` is not set (or set to `none`), the Gateway does not start a Backend Agent; chat and enabled frontend tools remain available.
Requests that require backend execution will return a clear explanation and will not create tasks or guess execution results. You can also
explicitly start in frontend-only mode with `qwenaudio --backend none`.

For selecting, one-click installing, permission modes, and persistent service of backend agents, see
[Backend Agents](../backends/overview.md). For more configuration options, see
[Configuration](../configuration.md). For TUI platform differences, see
[TUI Notes](tui.md); for the browser client, see [WebUI](webui.md).
