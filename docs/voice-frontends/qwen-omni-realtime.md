# Qwen Omni Realtime

The multimodal voice frontend: DashScope's Qwen3.5 Omni Realtime family.
Same full-duplex conversation as the Audio family, on models that
understand images at the model level.

## Models

| Model | Notes |
| --- | --- |
| `qwen3.5-omni-flash-realtime` | Lower latency |
| `qwen3.5-omni-plus-realtime` | Higher quality |

Both support Function Calling, so the Gateway's frontend tools (task
delegation, memory, reminders) work unchanged.

## Setup

```dotenv
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime
```

Same credential and endpoint settings as
[Qwen Audio 3.0 Realtime](qwen-audio-realtime.md) — one Gateway owns one
active model regardless of family; switch via Desktop settings or
`qwenaudio config set --realtime-model <id>`, then restart the Gateway.

## Voice and turn detection

- Default voice: `Ethan` — override with `QWEN_OMNI_REALTIME_VOICE`.
- Turn detection: `semantic_vad`, configured by the runtime.

## Capability boundary

This family is where the model/transport distinction matters:

| | Model | Current client transport |
| --- | --- | --- |
| Input | text, audio, **image** | text, audio |
| Output | text, audio | text, audio |

The models accept images; this release of qwen-audio-agent does not ship
the client and Gateway paths for them yet. JPEG observation frames and
native video transport stay disabled until those paths land — clients
show the image capability as unavailable rather than pretending to send
pixels. The capability tables above are exactly what the Gateway reports
to clients over the health endpoint, so UIs render the same boundary.

## Which family should I pick?

- **Audio** (`qwen-audio-3.0-realtime-*`) — the default; voice-first
  conversation, nothing else needed.
- **Omni** (`qwen3.5-omni-*-realtime`) — pick when you want the
  image-ready model family today, knowing image transport is still
  gated off.

## Read next

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.md) — the default family
- [Frontend configuration reference](../configuration/frontend.md)
