# X-Omni Visual Conversation

X-Omni is a standalone realtime multimodal interaction example. Qwen3.5 Omni
provides the default configuration for visual conversation, on-demand image
inspection, and user-requested observation. ModelBest MiniCPM-o can also use
continuous audiovisual conversation through the framework's existing adapter.
Scenario tools remain in the example, separate from the standard clients.

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

## Model configuration

The default Qwen model is `qwen3.5-omni-plus-realtime`; Flash can also be selected
with `QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime`.

For a separately deployed [MiniCPM-o service](../voice-frontends/minicpm-o.md),
replace the frontend configuration in `.env.local` with:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=video
AGENT_PROTOCOL=none
```

Use the endpoint of your deployment and set `MINICPM_O_AUTH_TOKEN` if needed.
No DashScope key is required. The client uses continuous frames with voice
input; typed input, on-demand inspection, observation, and backend tool calls
are unavailable through the current MiniCPM-o interface. Unsupported controls
are disabled rather than simulated.

Other Omni services require an appropriate Realtime Provider adapter. Visual
input alone does not guarantee tool calling or proactive reply support; see
the example README's compatibility table and integration requirements.

## Choose a capture mode

- **On-demand:** preview stays local until a visual tool requests a frame.
  A short-lived Omni reader inspects it and returns a textual observation.
- **Continuous:** with the microphone enabled, send one frame per second to
  the main Omni conversation. Ask about what is currently visible.

Select and authorize a camera, screen, or image first. Try “What is in this
picture?” or “Read the error message on the screen.”

## Watch and narrate

This section requires the Qwen configuration and its bundled visual reader.

Ask “Watch this progress bar for two minutes and tell me when it finishes”
or “Describe meaningful changes over the next minute.” Sampling runs every
10 seconds after an initial sample, defaults to two minutes, and is limited to
ten minutes and two observations. Use the status/stop buttons or speak to stop.

Observations incur additional model requests and cost. They are visual only,
not recording or safety alarms. Closing/changing the source, changing capture
mode, or disconnecting stops them; microphone mute alone does not.

In the Qwen configuration, an installed backend is optional for further work
with captured image references.

See the [complete example](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/x-omni)
for configuration, architecture, privacy, limits, and tests.
