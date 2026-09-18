# ADR-004: GPU Renderer Sidecar Boundary

- Status: Superseded by the Gateway-owned provider plan
- Scope: Digital human example
- Depends on: ADR-001, ADR-002, and ADR-003

## Context

SoulX-FlashHead Lite requires a CUDA-capable runtime and model-specific streaming
state. The development machine is an Apple Silicon Mac, while production-like
inference will run on a separate Linux GPU host.

The Mac Mock Renderer and CUDA Renderer must expose the same observable session
and speech lifecycle. Gateway and browser code must not depend on FlashHead tensor
shapes, checkpoint layout, inference windows, or CUDA deployment details.

## Decision

Run the real avatar implementation as an independent Python GPU Renderer service.
The service adapts the streaming behavior of OpenAvatarChat's FlashHead Processor
and uses SoulX-FlashHead Lite for inference.

The Renderer owns:

- Loading, warming, and releasing FlashHead model resources.
- Converting input PCM to the model's required sample rate and representation.
- Maintaining per-avatar motion and inference state.
- Windowing streaming audio and scheduling model inference.
- Producing a continuous 25 FPS video timeline.
- Pairing rendered frames with playable audio timestamps.
- Idle animation and the transition between idle and speaking.
- WebRTC media publication and Renderer-local health metrics.

The Renderer does not own:

- Conversation history or session restoration.
- ASR, LLM, tool calls, or TTS generation.
- Gateway authentication or application authorization.
- Persona conversation prompts.
- Decisions about whether two personas share conversation history.
- Gateway playback receipt semantics.

## External Contract

The browser sees only provider-neutral concepts:

- Avatar session creation, readiness, and closure.
- Speech start, ordered PCM chunks, finish, and interruption.
- First media playing, media ended, cancellation, and structured errors.
- A synchronized downstream audio/video stream.

FlashHead-specific configuration is selected server-side by `personaId` and a
deployment manifest. It is not sent as arbitrary client-controlled file paths or
model arguments.

## Audio Contract

The public input format for M1 and M2 is mono signed PCM16 little-endian at
24 kHz. The Renderer preserves that audio for downstream playback and derives a
16 kHz inference stream internally when required by the model.

Resampling must be streaming and stateful across chunks. Each `speechId` starts
with a fresh resampler state. Interruption discards pending resampler and model
windows for that speech.

## Model Adapter

The FlashHead implementation sits behind a Python adapter interface with these
conceptual operations:

```python
class AvatarModelAdapter:
    async def open_session(self, persona): ...
    async def push_audio(self, speech_id, pcm16_24k): ...
    async def finish_speech(self, speech_id): ...
    async def interrupt_speech(self, speech_id): ...
    async def render_idle(self): ...
    async def close_session(self): ...
```

The adapter emits timestamped video frames and does not directly implement the
network protocol. A separate session layer validates identifiers, sequence
numbers, cancellation, and backpressure.

## Concurrency and Isolation

Each `avatarSessionId` has isolated:

- Motion latent and reference-image state.
- Audio resampler and inference buffers.
- Frame queue and media timestamps.
- Cancellation token and generation counter.

A generation counter increments on interruption and persona change. Output from
an older generation is dropped before it reaches the WebRTC publisher, even if a
CUDA operation completes after cancellation.

The first implementation may allow one active avatar session per worker. Scaling
is achieved by routing sessions to workers rather than sharing model state across
browser connections without measured safety.

## Backpressure

The service uses bounded queues between network input, model inference, and media
publication. It never allows response audio to accumulate without limit.

When a queue cannot meet its configured latency budget, the Renderer reports a
structured overload error. The browser then applies the failure policy from
ADR-003. Silently dropping arbitrary PCM chunks is not allowed.

## Health and Readiness

The service exposes separate process health and model readiness:

- Liveness: event loop and service process are responsive.
- Readiness: model, persona assets, and media publisher can accept a session.
- Session status: warming, ready, speaking, idle, interrupted, or failed.

A process may be live but not ready while checkpoints are loading or GPU memory
is exhausted.

## Security Boundary

- The Renderer is not directly exposed as a public unauthenticated GPU endpoint.
- Session creation uses a short-lived credential minted or authorized by the
  application backend.
- `personaId` is resolved through an allowlisted manifest.
- Input size, session count, PCM rate, and queue depth are bounded.
- Logs contain identifiers and timing metadata, not raw conversation audio by
  default.

## Observability

At minimum, record these per-turn timestamps:

- First PCM accepted.
- Gateway audio upload completed.
- First inference window ready.
- First model frame produced.
- First WebRTC media frame played.
- Last media frame played.
- Interruption requested and locally settled.

Derived metrics include first-frame latency, audio-to-video skew, render FPS,
queue delay, real-time factor, fallback count, interruption settle time, and GPU
memory per active session.

## M2 Acceptance Criteria

- The same browser client can switch between Mock and CUDA Renderer using only
  configuration.
- PCM16 24 kHz input is accepted without changing Gateway output.
- Speech and idle output maintain a 25 FPS media timeline.
- Audio/video skew remains within the agreed product threshold for a complete
  test turn; the initial engineering target is absolute skew below 80 ms.
- First visible speaking frame latency is measured separately from Gateway TTS
  latency; the initial engineering target is p95 below 1.5 seconds on the chosen
  GPU profile.
- Sustained rendering meets real time for the supported concurrency profile,
  with no unbounded queue growth.
- Interruption prevents every older-generation frame from being published after
  the configured cancellation settle window; the initial target is 250 ms.
- Repeated create, speak, interrupt, and close cycles do not retain per-session
  model state or continually increase GPU memory.
- Renderer restart or overload produces a structured error that drives the
  browser state machine to a valid terminal state.
- No conversation transcript, prompt, or history is required by the Renderer.

Performance targets are provisional until the target GPU and network topology
are selected. Measurements must be reported with hardware, model revision,
resolution, FPS, concurrency, and transport settings.
