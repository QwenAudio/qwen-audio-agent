# Quick Start

If you haven't installed yet, see [Installation](install.md) first.

## 1. Create Configuration

```bash
qwenaudio config
```

The command will display the configuration file path and create a `config.env` template with comments.

## 2. Fill in Configuration

The minimal configuration only requires a DashScope API Key:

```dotenv
DASHSCOPE_API_KEY=your-key
```

When you need to execute backend tasks, select a backend agent and specify the backend model:

```dotenv
DASHSCOPE_API_KEY=your-key
# Voice frontend model: flash for lower latency and cost savings, plus (default) for better quality
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# Backend agent: leave empty or set to none to start in frontend-only mode
AGENT_PROTOCOL=openclaw
# Backend model: leave empty to use the agent's own user configuration; if not reused, the agent selects one
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

> The default uses the DashScope real-time voice frontend; you can also switch to a local [speech-to-speech frontend](../voice-frontends/speech-to-speech.md), which does not require a cloud API Key.

## 3. Start

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

## Frontend-Only Mode

When `AGENT_PROTOCOL` is not set (or set to `none`), the Gateway only provides real-time voice chat.
Requests that require backend execution will return a clear explanation and will not create tasks or guess execution results. You can also
explicitly start in frontend-only mode with `qwenaudio --backend none`.

For selecting, one-click installing, permission modes, and persistent service of backend agents, see
[Backend Agents](../backends/overview.md). For a complete list of environment variables, see
[Configuration](../configuration.md). For TUI platform differences, see
[TUI Notes](tui.md).
