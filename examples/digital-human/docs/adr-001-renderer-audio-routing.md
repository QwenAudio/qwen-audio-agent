# ADR-001: Renderer Audio Routing

- Status: Superseded by the Gateway-owned provider plan
- Decision owner: Example maintainers
- Scope: Digital human example and future production integration

## Context

The qwen-audio-agent Gateway already streams assistant PCM to the conversation
client through `audio.delta`. A digital human renderer needs the same audio,
correlated by `responseId`, before returning synchronized avatar audio/video.

Two routing options are viable:

```text
Option A: Gateway -> Browser -> Renderer
Option B: Gateway -> Renderer -> Browser
```

The choice determines whether avatar rendering remains a client presentation
concern or becomes a Gateway-owned delivery concern.

## Option A: Browser relay

```text
Gateway --GCP/audio.delta--> Browser --PCM--> Renderer
Gateway <--playback receipts-- Browser <--WebRTC media-- Renderer
```

### Benefits

- Uses the existing public Gateway protocol without core changes.
- Keeps avatar rendering optional and client specific.
- Allows ordinary voice, TUI, mobile, and custom clients to remain unchanged.
- Lets the browser own the renderer session and final playback clock.
- Makes renderer failure a presentation failure rather than a Gateway failure.
- Provides the shortest path to a self-contained example.

### Costs

- Adds one client-to-renderer network hop for assistant PCM.
- The browser must buffer audio for first-frame fallback.
- The browser handles two connections and renderer backpressure.
- Renderer credentials require a secure short-lived token flow.

## Option B: Gateway direct

```text
Browser --GCP--> Gateway --PCM--> Renderer
Browser <--control-- Gateway <--state-- Renderer
Browser <--------------WebRTC media------------- Renderer
```

### Benefits

- Removes the browser relay hop.
- Centralizes renderer capacity, policy, and credentials.
- Can keep renderer endpoints off the public network.
- May support non-browser clients through one server integration.

### Costs

- Requires a new Gateway renderer extension point and lifecycle ownership.
- Couples the core delivery path to a GPU service.
- Requires routing media credentials and renderer state back to the client.
- Complicates horizontal scaling because Gateway and renderer sessions must be
  correlated and recovered together.
- Expands the failure surface of every realtime connection.

## Proposed decision

Use Option A for M1 and M2:

```text
Gateway -> Browser -> Renderer
```

This is an example-level integration and preserves qwen-audio-agent's public
boundary. The expected FlashHead buffering and inference delay is likely larger
than the relay hop, but this must be confirmed by M2 measurements.

Do not treat Option A as an irreversible production choice. Keep renderer
messages provider neutral so a future Gateway-side `AvatarSink` can consume the
same logical protocol.

## Promotion criteria for Option B

Reconsider Gateway-direct routing only if measured evidence shows one or more
of the following:

- Browser relay adds material first-frame latency or jitter.
- Security policy prohibits a browser-to-renderer connection.
- Renderer capacity must be allocated centrally across many client types.
- Native clients cannot implement the renderer transport consistently.
- Production networking makes Gateway-to-renderer locality significantly more
  reliable than client-to-renderer connectivity.

## Invariants under either option

- qwen-audio-agent remains the only conversation and history owner.
- Renderer input is presentation data, not a second conversation request.
- `responseId` remains the speech correlation and interruption key.
- Renderer media is the only audible source while avatar mode is active.
- Renderer failure cannot mutate Gateway history or tool execution.
- Playback receipts reflect actual renderer playback, not audio upload.

## Decision required

Accept Option A for the initial example, or replace the proposed decision with
Option B before implementation begins.
