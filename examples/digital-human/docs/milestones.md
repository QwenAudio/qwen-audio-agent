# Digital Human Milestones

## M1: Mac-runnable integration skeleton

### Scope

- Add an independent digital human example.
- Define a provider-neutral renderer protocol.
- Add a mock renderer that runs without CUDA.
- Connect the client to the public Gateway protocol.
- Map `audio.delta`, `audio.done`, and `playback.clear` to renderer operations.
- Keep renderer audio as the only playback source in avatar mode.
- Fall back to existing audio playback when the renderer is unavailable.
- Support one default persona while keeping the data model ready for three.

### Acceptance criteria

- The example starts on macOS without NVIDIA dependencies.
- A realtime Gateway response enters the mock renderer under one `responseId`.
- Start, finish, interrupt, and stale-output behavior are observable in the UI.
- No assistant audio is played twice.
- Renderer failure does not terminate the Gateway conversation.
- No changes are required inside the core realtime provider implementation.

## M2: FlashHead GPU renderer

### Scope

- Add a Python renderer service for Linux/NVIDIA.
- Integrate SoulX-FlashHead Lite.
- Adapt the OpenAvatarChat streaming processor behavior.
- Convert 24 kHz Gateway PCM to 16 kHz inference audio while preserving the
  original 24 kHz playback stream.
- Produce synchronized audio/video media.
- Implement session-scoped motion state and interruption.
- Package the renderer in a pinned CUDA container.

### Acceptance criteria

- A fixed 24 kHz PCM fixture drives a condition image in streaming mode.
- Video remains at or above 25 FPS for one session on the reference GPU.
- First-frame latency, realtime factor, audio/video skew, GPU memory, and GPU
  utilization are recorded.
- Interrupt removes queued speech frames and returns to idle without old mouth
  motion leaking into the next response.
- Twenty sequential responses complete without unbounded memory growth.
- Two concurrent sessions are measured; three are attempted on RTX 4090.

## M3: Product-ready example

### Scope

- Add three personas, voices, condition images, and isolated histories.
- Prewarm or cache avatar state for acceptable persona-switch latency.
- Add renderer health, capacity, timeout, and reconnect telemetry.
- Add explicit degraded audio-only UI.
- Document local, remote-GPU, and production deployment.
- Audit third-party notices, model licenses, and generated-media labeling.

### Acceptance criteria

- Switching personas cannot mix conversation history or renderer frames.
- A renderer outage degrades cleanly and recovers on a later response.
- Capacity limits are visible and do not block text/tool execution.
- Performance targets and supported GPU profiles are documented from measured
  results.

## Deferred decisions

- WebRTC versus another low-latency media transport for the final sidecar.
- Whether renderer audio is returned by the sidecar or synchronized locally.
- Single shared GPU worker versus a worker pool.
- Condition-image preprocessing and cache format.
- Production GPU type and autoscaling strategy.

These decisions are deferred until M2 measurements exist.

