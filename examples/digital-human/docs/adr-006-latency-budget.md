# ADR-006: Realtime Latency Budget and Buffering

- Status: Proposed
- Scope: Digital human example
- Depends on: ADR-002 through ADR-004

## Context

A Renderer may produce frames faster than real time after inference begins and
still feel slow if it waits for a large audio window before the first frame. The
user-visible metric is mouth-motion latency after response audio becomes
available, not only model FPS.

OpenAvatarChat's FlashHead integration provides useful streaming behavior, but
its model windowing and queue sizes must not become unmeasured constants in this
example.

## Decision

Treat latency as an explicit budget across independently measured stages. Every
turn carries monotonic timestamps for:

```text
t0  Gateway response created
t1  first TTS PCM received by browser
t2  first PCM accepted by Renderer
t3  minimum inference window available
t4  first model frame produced
t5  first media packet published
t6  first synchronized frame played by browser
t7  final Gateway PCM received
t8  final rendered media played
```

The primary digital-human startup latency is `t6 - t1`. Gateway TTS startup
latency is reported separately as `t1 - t0`.

## Initial Engineering Budget

These values are provisional targets, not protocol guarantees:

| Stage | Initial target |
| --- | ---: |
| Browser relay and Renderer ingest, `t2 - t1` | p95 <= 100 ms |
| Initial audio accumulation, `t3 - t2` | <= 960 ms for baseline |
| First inference, `t4 - t3` | p95 <= 300 ms on selected GPU |
| Publish and browser playout, `t6 - t4` | p95 <= 150 ms |
| Total Renderer startup, `t6 - t1` | p95 <= 1.5 s |
| Steady-state absolute audio/video skew | <= 80 ms |
| Local interruption settlement | p95 <= 250 ms |

The baseline accumulation target reflects an expected approximately 24-frame
window at 25 FPS. It must be confirmed against the pinned FlashHead adapter
revision rather than assumed permanently.

## Buffering Rules

- Gateway PCM is forwarded immediately; the browser does not wait for
  `audio.done`.
- Renderer resampling is incremental and preserves state across chunks within
  one speech.
- Inference starts as soon as the adapter's minimum valid window is available.
- Rendered media uses a small bounded playout buffer to absorb jitter.
- Queue growth is bounded by elapsed media duration, not only chunk count.
- The Renderer reports overload rather than increasing latency without limit.

The system does not intentionally delay audio to accumulate an entire response.

## Timeline Ownership

Renderer creates one monotonic media timeline per `speechId`:

- Audio and video timestamps begin from the same speech origin.
- Video is scheduled at 25 FPS unless the selected model profile declares a
  different rate.
- Original 24 kHz PCM remains the audio source; a 16 kHz derived stream is used
  only for model inference.
- Idle frames are not assigned to an active speech timeline.
- Interruption increments the session generation and invalidates unpublished
  timestamps from the prior generation.

Browser playback receipts use actual playout events and must not be inferred
from model completion or packet publication.

## Adaptive Strategy

M2 begins with the model's known safe inference window. Optimization proceeds
only from measurement:

1. Establish the baseline with the pinned adapter and GPU profile.
2. Measure quality and latency using shorter or overlapping windows supported by
   the model.
3. Compare lip synchronization, identity stability, seam artifacts, GPU load,
   and interruption behavior.
4. Promote a new window only when it passes both visual and timing thresholds.

The browser protocol does not expose model window size. Renderer deployment
profiles may tune it without changing clients.

## Degraded Modes

- Renderer not ready before speech starts: use audio-only mode for that turn or
  wait only within an explicit first-media deadline.
- First-media deadline exceeded before playback: replay buffered PCM from the
  beginning according to ADR-003.
- Steady-state queue delay exceeds budget: fail the turn after playback starts;
  do not silently stretch the media timeline.
- Network jitter: absorb only up to the configured playout budget, then surface
  a structured stall error.

## Measurement Requirements

Every benchmark report includes:

- Commit and model/checkpoint revision.
- GPU model, driver, CUDA, precision, and memory use.
- Avatar resolution, frame rate, and inference-window configuration.
- Network topology and round-trip time.
- Number of concurrent sessions.
- Warm and cold startup results.
- At least p50, p95, and maximum startup latency.
- Audio/video skew distribution and interruption latency.

Browser and Renderer clocks must be correlated for cross-process spans. Where
clock synchronization is insufficient, the report uses request/response spans
measured by one clock and labels them accordingly.

## Acceptance Criteria

- A timing trace can explain every interval from first Gateway PCM to first
  browser playout.
- The implementation never waits for the complete response before inference.
- Queues have explicit duration and memory bounds.
- Startup latency, steady-state skew, and interruption latency are measured as
  separate metrics.
- Model FPS alone is never used as evidence that the experience is realtime.
- Changes to inference-window size require before-and-after timing and visual
  quality evidence.

