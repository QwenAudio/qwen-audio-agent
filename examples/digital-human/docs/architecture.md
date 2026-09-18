# Digital Human Example Architecture

## Decision

qwen-audio-agent remains the only owner of the conversation. The avatar system
is a presentation sink that consumes assistant audio and returns synchronized
audio and video.

```text
Browser                       qwen-audio-agent Gateway
  |                                      |
  | microphone, text, controls           | Qwen Audio Realtime
  |<------------- GCP ------------------>| sessions, history, tools
  |                                      |
  |                                      | PCM16 24 kHz + responseId
  |                                      v
  |                           Avatar Renderer Sidecar
  |                           - 24 kHz playback audio
  |                           - 16 kHz inference audio
  |                           - FlashHead Lite
  |<----------- synchronized media ------|
```

The renderer never receives prompts, memory, user credentials, tool schemas, or
conversation history. Its correlation key is the Gateway `responseId`.

## Runtime ownership

| Concern | Owner |
| --- | --- |
| Microphone capture | Digital human client |
| Turn detection and realtime conversation | qwen-audio-agent Gateway |
| Session history and recovery | qwen-audio-agent Gateway |
| Tools and background work | qwen-audio-agent Gateway |
| Assistant profile and output voice | qwen-audio-agent Gateway |
| Audio-to-face inference | Avatar Renderer |
| Audio/video synchronization | Avatar Renderer |
| Visible avatar and playback controls | Digital human client |

## Audio ownership

There must be exactly one audible playback path.

```text
voice mode:   Gateway audio.delta -> Web Audio
avatar mode:  Gateway audio.delta -> Renderer -> synchronized media
fallback:     Renderer unavailable -> Web Audio
```

The client must not play Gateway PCM while also playing renderer audio. Doing
so produces echo and breaks lip synchronization.

## Gateway event mapping

| Gateway event | Renderer operation |
| --- | --- |
| `voice.ready` | Prewarm or verify the renderer session |
| `audio.delta` | Append PCM associated with `responseId` |
| `audio.done` | Finish the current speech stream |
| `playback.clear` | Interrupt and discard buffered frames |
| Gateway disconnect | Close the renderer session |

Renderer playback events map back to Gateway receipts:

| Renderer event | Gateway receipt |
| --- | --- |
| First synchronized frame played | `playback.started` |
| Speech stream drained | `playback.ended` |
| Stream interrupted or renderer failed | `playback.cancelled` |

## Renderer implementation

The GPU implementation uses SoulX-FlashHead Lite and follows the streaming
processor design in OpenAvatarChat:

- Model inference consumes mono float audio at 16 kHz.
- Original 24 kHz audio is retained for client playback.
- Each Gateway `responseId` becomes a renderer `speechId`.
- Model weights are shared while motion and audio buffers are session scoped.
- Output video frames and audio segments advance on the same 25 FPS clock.
- Interrupt clears pending audio, generated speech frames, and residual mouth
  motion before the next response starts.

The renderer is a separate Python process so CUDA, PyTorch, FlashAttention, and
model dependencies never enter the Node.js Gateway process.

## Development topology

### Mac development

```text
MacBook Pro
- qwen-audio-agent Gateway
- digital-human client
- mock renderer
```

The mock renderer validates protocol state, interruption, fallback, and UI. It
does not attempt model inference.

### GPU development

```text
MacBook Pro                         Linux NVIDIA host
- Gateway                          - Python renderer
- browser        <network>         - FlashHead Lite
- microphone                       - WebRTC media output
```

SoulX-FlashHead Lite's published realtime target is an RTX 4090. Other GPU
types require measurement rather than assumption.

## Personas and sessions

Conversation and avatar session identifiers must remain distinct:

```text
conversationSessionId  Gateway history and recovery
avatarSessionId        Renderer resource lifetime
personaId              Trusted assistant profile and visible skin
```

Each persona maps to a trusted Gateway profile, voice, and condition image.
When histories must be isolated by persona, the client uses a stable,
persona-specific `conversationSessionId`.

Switching persona follows this order:

1. Cancel current playback.
2. Interrupt and close the current avatar session.
3. Switch the Gateway conversation session/profile/voice.
4. Create or attach the next avatar session.
5. Resume microphone input only after both sides are ready.

## Failure behavior

- Renderer startup failure falls back to normal audio playback.
- Renderer failure during a response cancels that renderer stream and resumes
  audio-only mode from the next response; it does not replay partial audio.
- A late frame with an inactive `responseId` is discarded.
- Reconnect never replays rendered media from conversation history.
- Renderer capacity errors are presentation failures, not conversation errors.

## Security boundary

- Renderer session credentials are short lived.
- The browser never receives infrastructure credentials or model storage keys.
- Renderer endpoints authenticate the Gateway/client session before accepting
  audio.
- Generated frames and audio are not persisted by default.
- Production deployments must label AI-generated media as required by policy.

