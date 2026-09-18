# ADR-003: Browser Playback State Machine

- Status: Superseded by the Gateway-owned provider plan
- Scope: Digital human example
- Depends on: ADR-001 and ADR-002

## Context

The browser receives assistant audio before the Renderer has necessarily created
playable media. It must coordinate buffering, Renderer playback, interruption,
fallback, persona changes, and Gateway playback receipts without allowing stale
audio or video to revive a completed response.

This behavior must be identical for the Mac Mock Renderer and the CUDA Renderer.

## State Model

The browser keeps one controller per `responseId`. A controller is monotonic and
may enter each state at most once.

```text
IDLE
  -> BUFFERING
  -> WAITING_FOR_MEDIA
  -> PLAYING_RENDERER
  -> COMPLETED

BUFFERING / WAITING_FOR_MEDIA
  -> PLAYING_FALLBACK
  -> COMPLETED

BUFFERING / WAITING_FOR_MEDIA / PLAYING_RENDERER / PLAYING_FALLBACK
  -> CANCELLING
  -> CANCELLED

BUFFERING / WAITING_FOR_MEDIA / PLAYING_RENDERER
  -> FAILED
```

Terminal states are `COMPLETED`, `CANCELLED`, and `FAILED`. No event may move a
controller out of a terminal state.

## State Responsibilities

### `IDLE`

No active assistant response exists. The browser may create a controller only
after receiving a new Gateway response identifier.

### `BUFFERING`

The browser forwards ordered PCM chunks to the Renderer and retains a complete
fallback copy. No audio is audible yet.

### `WAITING_FOR_MEDIA`

Gateway audio upload has finished, but the Renderer has not reported the first
actually played synchronized frame. The fallback copy remains available.

### `PLAYING_RENDERER`

The first synchronized Renderer frame has been consumed by the browser. The
browser emits `playback.started` exactly once and releases the fallback buffer.
Gateway PCM must never be sent to the local audio player in this state.

### `PLAYING_FALLBACK`

Renderer failed before playback began. The browser closes the Renderer turn and
plays the complete retained PCM stream from its beginning. Renderer packets for
this `responseId` are ignored.

### `CANCELLING`

The browser atomically marks the controller stale, stops local media, sends
`speech.interrupt`, clears all queues, and emits `playback.cancelled` once.

### Terminal States

`COMPLETED` follows complete Renderer or fallback playback. `CANCELLED` follows
an explicit interruption or persona switch. `FAILED` represents an unrecoverable
turn failure after Renderer playback has started.

## Events and Transitions

| Current state | Event | Next state | Required action |
| --- | --- | --- | --- |
| `IDLE` | Gateway response starts | `BUFFERING` | Create controller and Renderer turn |
| `BUFFERING` | PCM chunk | `BUFFERING` | Buffer and forward ordered bytes |
| `BUFFERING` | Gateway audio done | `WAITING_FOR_MEDIA` | Send `speech.finish` |
| `BUFFERING` | Renderer first media | `PLAYING_RENDERER` | Emit started; discard fallback buffer |
| `WAITING_FOR_MEDIA` | Renderer first media | `PLAYING_RENDERER` | Emit started; discard fallback buffer |
| `BUFFERING` or `WAITING_FOR_MEDIA` | Renderer unavailable | `PLAYING_FALLBACK` | Replay buffered PCM from byte zero |
| `PLAYING_RENDERER` | Renderer media drained | `COMPLETED` | Emit ended and release turn resources |
| `PLAYING_FALLBACK` | Local audio drained | `COMPLETED` | Emit ended and release turn resources |
| Any non-terminal state | User interruption | `CANCELLING` | Stop, clear, interrupt, emit cancelled |
| Any non-terminal state | Persona switch | `CANCELLING` | Cancel turn before replacing session |
| `PLAYING_RENDERER` | Renderer failure | `FAILED` | Stop media and emit cancelled; no fallback |

`CANCELLING` immediately settles to `CANCELLED` after local cleanup. It does not
wait indefinitely for a Renderer acknowledgement.

## Event Admission Rules

An incoming Renderer event is accepted only when all of these match the active
controller:

- `avatarSessionId`
- `responseId`
- `speechId`
- Expected monotonically increasing sequence number

Duplicates are idempotently ignored. Gaps are treated as a protocol error. Any
event arriving for a terminal controller or an older avatar session is ignored.

## Timeouts

Timeout values are runtime configuration, not protocol constants. The state
machine exposes three independent timeout classes:

- Renderer connection timeout before a turn starts.
- First-media timeout while buffering or waiting.
- Media-stall timeout after playback begins.

Only connection and first-media timeouts may use audio fallback. A media-stall
timeout after playback begins fails the turn without changing audio source.

## Persona Switching

Persona switching is serialized:

1. Cancel the active response controller, if any.
2. Close the current `avatarSessionId` locally without waiting forever for the
   remote Renderer.
3. Stop and detach the old WebRTC tracks.
4. Create a new avatar session using the selected `personaId`.
5. Accept new Gateway responses only after that session is ready, or explicitly
   enter audio-only mode.

The Gateway `conversationSessionId` is unchanged unless the product explicitly
chooses separate conversation history per persona.

## Acceptance Criteria

- Every response produces at most one started, ended, or cancelled receipt of
  each applicable type.
- Cancellation completes locally even if the Renderer is unreachable.
- No terminal response can return to a playing state.
- No packet from an earlier persona or avatar session can become visible or
  audible after switching.
- Audio fallback always starts at byte zero and is permitted only before first
  Renderer playback.
- Renderer playback and fallback playback are mutually exclusive.
- Mock and CUDA Renderer integrations pass the same transition test vectors.
