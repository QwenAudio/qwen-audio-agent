# Qwen Omni Realtime

The multimodal voice frontend: DashScope's Qwen3.8 and Qwen3.5 Omni Realtime models.
Same full-duplex conversation as the Audio family, on models that
understand images at the model level.

## Models

| Model | Notes |
| --- | --- |
| `qwen3.8-omni-flash-realtime` | Requires a workspace-specific endpoint |
| `qwen3.5-omni-flash-realtime` | Lower latency |
| `qwen3.5-omni-plus-realtime` | Higher quality |

These models support Function Calling, so the Gateway's frontend tools (task
delegation, memory, reminders) work unchanged.

## Setup

Both generations use the `dashscope` provider; select the model with
`QWEN_AUDIO_REALTIME_MODEL` in your Gateway's `config.env`.

### Qwen3.8 Omni

3.8 requires a workspace-specific WebSocket endpoint and an API key for that region and workspace:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.8-omni-flash-realtime
QWEN_AUDIO_REALTIME_BASE_URL=wss://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime
```

Replace `<WorkspaceId>` with your workspace ID. For Singapore, use
`<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com`. See the [official connection guide](https://help.aliyun.com/zh/model-studio/realtime).
In Desktop, keep DashScope selected and use the existing endpoint, API key, and model fields; no new provider is needed.
The default public DashScope endpoint cannot be used for this model.
A Gateway uses one active model at a time. Apply settings or restart the Gateway after changing configuration. The default model is unchanged.

### Qwen3.5 Omni

The 3.5 family uses the same credential and endpoint settings as
[Qwen Audio 3.0 Realtime](qwen-audio-realtime.md).

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime
```

## Voice and turn detection

- Project voice defaults: `Tina` for 3.8, `Ethan` for 3.5 — override with `QWEN_OMNI_REALTIME_VOICE`.
- On 3.5, the known-incompatible `Cherry` selection is rejected before connecting, with a
  suggestion to use this project's model default. Unknown and cloned voice IDs
  are passed to the provider; no allowlist, ID-prefix inference, or automatic
  fallback is applied. See the [official voice list](https://help.aliyun.com/zh/model-studio/omni-voice-list).
- Turn detection: `semantic_vad`, configured by the runtime.
- 3.8 uses nested `session.audio` configuration. Client audio stays mono PCM16: 16 kHz input, 24 kHz output.
  Tool-result continuation, proactive backend replies, and interruption reuse the existing DashScope path. Upstream-hosted MCP and multichannel audio are not enabled.

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
- **Omni** — pick when you want the frontend to combine live visual frames with voice;
  3.8 additionally requires a workspace-specific endpoint.

## Read next

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.md) — the default family
- [GPT-Live / OpenAI Realtime](gpt-live.md) — OpenAI cloud realtime frontend
- [Google Gemini Live](google-live.md) — Google cloud realtime frontend
- [Frontend configuration reference](../configuration/frontend.md)
