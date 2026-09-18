# X-Omni Visual Conversation

X-Omni is a standalone example for Qwen3.5 Omni Realtime. It adds camera/screen
conversation, on-demand image inspection, explicitly requested visual reminders,
and change narration without adding scenario tools to the standard clients.

## Start

From a source checkout using the repository's supported Node.js version:

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

Fill in `DASHSCOPE_API_KEY`, then:

```bash
npm run example:x-omni
```

Open **http://127.0.0.1:5178**. The example uses a separate Gateway on port 18890
and defaults to frontend-only mode. It does not reuse your desktop Gateway.

## Choose a capture mode

- **On-demand:** preview stays local until a visual tool requests a frame.
  A short-lived Omni reader inspects it and returns a textual observation.
- **Continuous:** with the microphone enabled, send one frame per second to
  the main Omni conversation. Ask about what is currently visible.

Select and authorize a camera, screen, or image first. Try “What is in this
picture?” or “Read the error message on the screen.”

## Watch and narrate

Ask “Watch this progress bar for two minutes and tell me when it finishes”
or “Describe meaningful changes over the next minute.” Sampling runs every
10 seconds after an initial sample, defaults to two minutes, and is limited to
ten minutes and two observations. Use the status/stop buttons or speak to stop.

Observations incur additional model requests and cost. They are visual only,
not recording or safety alarms. Closing/changing the source, changing capture
mode, or disconnecting stops them; microphone mute alone does not.

The default model is `qwen3.5-omni-plus-realtime`; Flash is also configurable.
An installed backend is optional for further work with captured image references.

See the [complete example](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/x-omni)
for configuration, architecture, privacy, limits, and tests.
