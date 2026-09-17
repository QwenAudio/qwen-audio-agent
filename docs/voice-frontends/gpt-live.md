# GPT-Live / OpenAI Realtime

qwen-audio-agent can connect to OpenAI's GPT-Live / Realtime WebSocket API as
a cloud voice frontend. Gateway still owns frontend tools, memory, reminders,
task delegation, and backend-Agent orchestration; the provider adapter only
translates the OpenAI GA Realtime wire shape into the shared runtime.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live
OPENAI_API_KEY=your-openai-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_REALTIME_URL` / `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime` | WebSocket endpoint |
| `GPT_LIVE_REALTIME_MODEL` / `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | Current built-in model profile |
| `GPT_LIVE_REALTIME_VOICE` / `OPENAI_REALTIME_VOICE` | Empty | Service default, or a voice ID supported by the model |
| `GPT_LIVE_API_KEY` | Empty | Alias for `OPENAI_API_KEY` when the realtime frontend needs a separate credential |

Desktop exposes the same fields under **Voice frontend → GPT-Live**. Restart a
terminal Gateway after editing the file; for an installed service, run
`qwenaudio gateway restart`.

## Integration boundary

- The adapter uses OpenAI's GA Realtime dialect over WebSocket. It sends the
  model as the URL `model` query parameter and authenticates with
  `Authorization: Bearer ...`.
- Input and output use mono 24 kHz PCM. Client audio is resampled by the
  Gateway client before it reaches the provider.
- Gateway registers its own function tools with the model. Built-in OpenAI
  tools are not enabled by this adapter.
- Response metadata correlation is enabled, so Gateway-created replies can be
  distinguished from automatic server-side responses.
- The current built-in model profile supports text/audio input and text/audio
  output. Live visual frames are not negotiated for this provider.

## Validation boundary

Local protocol tests cover URL construction, session configuration, model
capability reporting, and provider registration. Live model behavior, voices,
latency, quotas, and regional availability require a valid OpenAI account and
are governed by OpenAI's current Realtime API documentation.

## Read next

- [Google Gemini Live](google-live.md)
- [Frontend configuration reference](../configuration/frontend.md)
- [Custom Provider](custom-provider.md)
