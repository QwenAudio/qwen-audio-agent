# Avatar Renderer Protocol

This document defines the logical protocol. M1 may carry it over a local mock
transport; M2 will bind control messages to WebSocket and media to WebRTC or an
equivalent low-latency transport.

## Session lifecycle

### Create

```json
{
  "type": "session.create",
  "requestId": "request-1",
  "personaId": "healer",
  "conditionImage": "avatar://healer"
}
```

```json
{
  "type": "session.ready",
  "requestId": "request-1",
  "avatarSessionId": "avatar-session-1",
  "input": {
    "encoding": "pcm_s16le",
    "sampleRate": 24000,
    "channels": 1
  }
}
```

### Close

```json
{
  "type": "session.close",
  "avatarSessionId": "avatar-session-1"
}
```

Closing is idempotent and releases renderer capacity.

## Speech stream

### Start

```json
{
  "type": "speech.start",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1"
}
```

### Append audio

```json
{
  "type": "speech.audio",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1",
  "sequence": 0,
  "audio": "<base64 PCM16>"
}
```

Sequence numbers are monotonic within one response. Duplicate sequence numbers
are ignored. A gap fails the speech stream rather than rendering corrupted
audio.

### Finish

```json
{
  "type": "speech.finish",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1",
  "lastSequence": 42
}
```

### Interrupt

```json
{
  "type": "speech.interrupt",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1",
  "reason": "gateway_clear"
}
```

Interrupt is idempotent. Audio, generated speech frames, and delayed completion
events for that response must be discarded.

## Renderer events

```json
{
  "type": "speech.playing",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1"
}
```

```json
{
  "type": "speech.ended",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1"
}
```

```json
{
  "type": "speech.cancelled",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1",
  "reason": "interrupted"
}
```

```json
{
  "type": "renderer.error",
  "avatarSessionId": "avatar-session-1",
  "responseId": "response-1",
  "code": "capacity_exhausted",
  "recoverable": true,
  "message": "Renderer capacity is temporarily unavailable"
}
```

## Invariants

- Only one response may be audible per avatar session.
- Every renderer event is correlated by `avatarSessionId` and `responseId`.
- Events for an inactive response are ignored by the client.
- `speech.ended` means synchronized media playback has drained, not merely that
  input audio has finished uploading.
- Renderer errors never mutate Gateway history or session state.
- Media history is not replayed when a Gateway session recovers.

