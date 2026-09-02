# Qwen Audio 3.0 Realtime

The default voice frontend: DashScope's Qwen Audio 3.0 Realtime family,
purpose-built for speech-to-speech conversation. This is what you get when
you install qwen-audio-agent and only set an API key.

## Models

| Model | Notes |
| --- | --- |
| `qwen-audio-3.0-realtime-plus` | **Default.** Higher quality |
| `qwen-audio-3.0-realtime-flash` | Lower latency, lower cost |

Both accept text and audio input, produce text and audio output, and
support Function Calling (which is how the Gateway's frontend tools —
task delegation, memory, reminders — reach the model).

## Setup

```dotenv
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
```

`DASHSCOPE_API_KEY` can be replaced by the higher-priority alias
`QWEN_AUDIO_REALTIME_API_KEY` when the realtime frontend needs its own
credential.

One Gateway owns one active model. Switch it from the Desktop settings
page or from the CLI, then restart the Gateway:

```bash
qwenaudio config set --realtime-model qwen-audio-3.0-realtime-flash
qwenaudio gateway restart
```

WebUI and TUI only display the active model; they never override it.

## Voice and turn detection

- Default voice: `longanqian` — override with `QWEN_AUDIO_REALTIME_VOICE`.
- A GCP client may provide a session-scoped voice in
  `connection.output_voice` on its initial `session.hello`. It takes precedence
  over the environment default. At runtime, call
  `GatewayClient.updateOutputVoice(voice)`; the Gateway rebuilds the upstream
  Realtime Session while preserving the Client connection and Gateway session.
- Turn detection: `smart_turn` (semantic end-of-turn), configured by the
  runtime; no manual VAD tuning is exposed.

## Endpoint overrides

For private deployments or proxies:

| Setting | Effect |
| --- | --- |
| `QWEN_AUDIO_REALTIME_BASE_URL` / `QWEN_AUDIO_REALTIME_URL` | Replace the DashScope Realtime endpoint |
| `DASHSCOPE_WORKSPACE_ID` | Switch to a Bailian dedicated-workspace endpoint (`wss://<workspace-id>.cn-beijing.maas.aliyuncs.com/...`) |

The transport runs 16 kHz PCM input and 24 kHz PCM output over a single
WebSocket.

## Capability boundary

| | Model | Current client transport |
| --- | --- | --- |
| Input | text, audio | text, audio |
| Output | text, audio | text, audio |

Model capability and implemented transport are deliberately tracked
separately; this family has no image modality to gap. For image input at
the model level, see [Qwen Omni Realtime](qwen-omni-realtime.md).

## Read next

- [Speech-to-Speech](speech-to-speech.md) — fully local frontend, no cloud key
- [Custom Provider](custom-provider.md) — bring another realtime service
- [Frontend configuration reference](../configuration/frontend.md)
