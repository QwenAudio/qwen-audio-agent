# ADR-002: Renderer Media Transport

- Status: Superseded by the Gateway-owned provider plan
- Scope: Digital human example
- Depends on: ADR-001 renderer audio routing

## Context

The qwen-audio-agent Gateway already streams 24 kHz PCM response audio to the
browser. The digital-human renderer must consume that audio, generate lip-synced
video, and return media that can be played without introducing a second audible
copy of the response.

Using one transport for control messages, raw PCM upload, signaling, audio, and
video would make interruption and failure recovery difficult to reason about.

## Decision

Use two logical transport paths between the browser and Renderer:

1. WebSocket for Renderer control, WebRTC signaling, and upstream PCM audio.
2. WebRTC for downstream synchronized audio and video.

The browser remains the relay between the Gateway and Renderer for M1 and M2:

```text
Gateway --WebSocket/PCM--> Browser
Browser --WebSocket/control+PCM--> Renderer
Renderer --WebRTC/audio+video--> Browser
```

The WebSocket protocol remains provider-neutral. A real Renderer may implement
the media output with WebRTC while the M1 Mock Renderer may emulate the same
lifecycle without producing GPU-rendered video.

## Audio Ownership

In digital-human mode, Renderer output is the only audible source. The browser
must not play the Gateway PCM stream at the same time.

The browser buffers the original PCM until Renderer playback starts:

- Failure before the first rendered media is played: close the Renderer turn
  and replay the buffered PCM from the beginning in audio-only mode.
- Failure after rendered media starts: cancel the current turn and do not switch
  audio sources mid-turn. Start the next turn in audio-only mode.

`audio.done` means that all audio has been uploaded; it does not mean playback
has completed.

## Playback Receipts

Gateway playback receipts are derived from actual Renderer playback:

- First synchronized media rendered: `playback.started`.
- Renderer media queue drained: `playback.ended`.
- Interruption or Renderer failure: `playback.cancelled`.

## Interruption

On interruption, the browser performs all of the following for the same
`responseId`:

1. Stops and discards downstream Renderer media.
2. Sends `speech.interrupt` to the Renderer.
3. Clears buffered original PCM for the turn.
4. Reports cancellation to the Gateway.

Late packets are ignored by matching `responseId`, `avatarSessionId`, and
monotonic sequence numbers.

## Session Identity

The implementation keeps these identifiers independent:

- `conversationSessionId`: Gateway conversation and history ownership.
- `avatarSessionId`: lifetime of one Renderer avatar instance.
- `personaId`: selected appearance and persona configuration.
- `responseId`: one assistant response shared across Gateway and Renderer events.

M1 keeps only one active `avatarSessionId`. Switching persona interrupts and
closes the current Renderer session before creating the next one.

## Consequences

- Gateway behavior and its public realtime protocol remain unchanged.
- The Renderer owns downstream audio/video synchronization and timestamps.
- The browser owns relay buffering, fallback, receipt mapping, and stale-packet
  rejection.
- WebRTC setup is deferred behind the provider-neutral lifecycle, allowing the
  Mac Mock Renderer to validate state transitions before a CUDA renderer exists.

## Acceptance Criteria

- A response is never audible from both Gateway PCM and Renderer media.
- An interruption cannot resume stale video or audio from an older response.
- Renderer failure before playback can fall back to complete audio from the
  beginning.
- Renderer failure after playback never produces a mid-sentence source switch.
- Playback receipts reflect media consumption rather than upload completion.
- Changing `personaId` cannot leak queued media from the previous
  `avatarSessionId`.
