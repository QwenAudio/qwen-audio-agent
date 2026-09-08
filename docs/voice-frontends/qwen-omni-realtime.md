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

- Default voice: `Tina` — override with `QWEN_OMNI_REALTIME_VOICE`.
- `Cherry` is a Qwen3-Omni voice, not a Qwen3.5-Omni voice. If configured,
  the runtime falls back to `Tina` to avoid a silent session close.
- Turn detection: `semantic_vad`, configured by the runtime.

## Live vision

WebUI can sample a camera as bounded JPEG
frames and send them over the negotiated GCP `input.image_buffer` capability.
The Gateway accepts at most one frame per second and the provider adapter sends
it through Qwen Omni's `input_image_buffer.append` after audio has established
the realtime timeline. Image and audio buffers are committed together by the
provider's normal turn detection.

This path is live visual context, not a turn attachment: it does not create a
user message, trigger a response, enter history, or become a backend-Agent
attachment. Ordinary uploaded images still use `conversation.item.create` and
the existing attachment/delegation path. Desktop and TUI do not capture live
visual frames in this release.

## Which family should I pick?

- **Audio** (`qwen-audio-3.0-realtime-*`) — the default; voice-first
  conversation, nothing else needed.
- **Omni** (`qwen3.5-omni-*-realtime`) — pick when you want the
  frontend to combine live visual frames with voice.

## Read next

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.md) — the default family
- [Frontend configuration reference](../configuration/frontend.md)
