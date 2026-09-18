# Digital Human Gateway Provider Plan

## 1. Objective

Add digital-human output as an optional qwen-audio-agent capability without
duplicating ASR, LLM, TTS, avatar inference, or media-processing implementations.

The client integrates only with the qwen-audio-agent Gateway. The Gateway owns
conversation orchestration, authentication, cancellation, fallback, and public
protocol semantics. A replaceable `DigitalHumanProvider` turns assistant text
and audio into synchronized avatar media.

The first real provider reuses the Avatar component from OpenAvatarChat and
SoulX-FlashHead Lite. OpenAvatarChat ASR, LLM, TTS, and frontend components are
not part of this integration.

## 2. Architecture

```text
Client
  | public control: existing Realtime WebSocket plus optional avatar events
  | public media: Gateway-owned WebRTC endpoint
  v
qwen-audio-agent Gateway
  |-- Realtime session and history
  |-- Qwen Realtime adapter
  |-- DigitalHumanOrchestrator
  |-- DigitalHumanProvider SPI
  `-- Media Gateway
          |
          | private provider protocol
          v
OpenAvatarChatAvatarProvider sidecar
  |-- thin qwen provider adapter
  |-- OpenAvatarChat Avatar processor
  `-- SoulX-FlashHead Lite
```

The client never connects to the provider directly and never sees
OpenAvatarChat-specific messages, model paths, or deployment details.

## 3. Responsibility Boundaries

### Qwen Realtime

- Consumes user microphone audio.
- Performs speech understanding, conversation generation, and tool use.
- Produces assistant text deltas and PCM audio deltas.
- Remains the source of truth for response lifecycle and `responseId`.

For the current speech-to-speech model, its generated audio replaces the ASR,
LLM, and TTS chain that OpenAvatarChat would otherwise run.

### Gateway

- Owns the public client session and conversation history.
- Selects and authorizes `personaId` and provider configuration.
- Converts Realtime output events into provider input events.
- Buffers original PCM until avatar playback starts so startup failure can fall
  back to ordinary audio.
- Maps content filtering, user interruption, disconnects, and provider failures
  into one terminal response state.
- Owns the client-facing WebRTC session and playback receipts.
- Prevents stale provider output from an older response or avatar generation.

### DigitalHumanProvider

- Accepts streaming assistant text and audio.
- Uses audio as the authoritative playback and lip-sync timeline.
- May use text for emotion, gesture, subtitle, or semantic enhancement.
- Produces synchronized media plus provider lifecycle events.
- Supports bounded interruption and session closure.
- Does not receive conversation history, user microphone audio, tool calls, or
  arbitrary client-controlled model configuration.

### OpenAvatarChatAvatarProvider

- Reuses OpenAvatarChat's Avatar processor and its existing FlashHead streaming
  behavior rather than copying that implementation into qwen-audio-agent.
- Loads SoulX-FlashHead Lite and avatar assets.
- Maintains model windows, motion state, idle behavior, frame scheduling, and
  audio/video timestamps.
- Uses an internal inference copy of the audio at the model-required sample rate
  while preserving the original audio for synchronized playback.
- Hides all OpenAvatarChat message and Python types behind the provider contract.

## 4. Provider SPI

The contract is semantic rather than model-specific. The exact language binding
may be TypeScript in Gateway and JSON/binary messages for a Python sidecar.

```ts
interface DigitalHumanProvider {
  getCapabilities(): Promise<DigitalHumanCapabilities>;
  createSession(config: DigitalHumanSessionConfig): Promise<DigitalHumanSession>;
}

interface DigitalHumanSession {
  startTurn(input: { responseId: string }): Promise<void>;

  appendText(input: {
    responseId: string;
    sequence: number;
    delta: string;
  }): Promise<void>;

  appendAudio(input: {
    responseId: string;
    sequence: number;
    format: "pcm_s16le_24000_mono";
    data: Uint8Array;
  }): Promise<void>;

  commitTurn(responseId: string): Promise<void>;
  interruptTurn(responseId: string, reason: string): Promise<void>;
  events(): AsyncIterable<DigitalHumanEvent>;
  close(): Promise<void>;
}
```

Required event concepts are:

```text
session.ready
turn.first_media
turn.completed
turn.cancelled
provider.error
```

Every turn event includes `avatarSessionId`, `responseId`, and the current
generation. Events from an older generation are ignored.

## 5. Provider Capabilities

The Gateway negotiates capabilities instead of assuming every provider behaves
like FlashHead.

```json
{
  "streamingAudio": true,
  "streamingText": true,
  "textOptional": true,
  "interrupt": true,
  "idleAnimation": true,
  "inputAudioFormats": ["pcm_s16le_24000_mono"],
  "mediaOutput": "timestamped_audio_video"
}
```

A future provider may ignore text, consume complete text only, return WebRTC
tracks, return encoded frames, or emit animation parameters. Transport adapters
belong below the SPI and do not change the Realtime event mapping.

## 6. Realtime Event Mapping

```text
Realtime response.created
  -> provider.startTurn(responseId)

Realtime response audio transcript delta
  -> client text event
  -> provider.appendText(responseId, delta)

Realtime response audio delta
  -> fallback PCM buffer
  -> provider.appendAudio(responseId, pcm)

Realtime response audio done
  -> provider.commitTurn(responseId)

Realtime cancellation, content filtering, or user interruption
  -> provider.interruptTurn(responseId, reason)
  -> invalidate response generation
  -> clear pending client media
```

Provider delivery begins on the first audio chunk. It must not wait for the full
response or a WAV file.

## 7. Media Path

The Gateway is the client's only logical integration point:

```text
Client <-- Realtime WebSocket --> Gateway
Client <-- Gateway WebRTC ------> Gateway Media Gateway
Gateway <-- private media ------> Provider sidecar
```

For M1, the Mock Provider may deliver deterministic timestamped placeholder
frames over the private provider connection. The Gateway then exposes them using
the simplest local media adapter suitable for the example.

For the real provider, the private transport may use encoded frames, RTP, or a
WebRTC/WHIP-style publisher. This is an internal deployment decision. The public
client contract remains Gateway-owned.

In avatar mode, there is one audible source. The synchronized avatar media owns
playback. Raw Realtime PCM is retained temporarily for fallback but is not played
at the same time.

## 8. Public Protocol Extension

The existing protocol receives a backward-compatible optional extension:

```json
{
  "type": "session.update",
  "session": {
    "digital_human": {
      "enabled": true,
      "persona_id": "persona-a",
      "output_mode": "avatar"
    }
  }
}
```

The minimum server event set is:

```text
digital_human.session.starting
digital_human.session.ready
digital_human.session.error
response.digital_human.started
response.digital_human.completed
response.digital_human.cancelled
response.digital_human.error
```

Legacy clients that do not enable the extension continue receiving ordinary text
and audio behavior.

## 9. Session and Persona Model

```text
ownerId                 stable authenticated user
conversationSessionId   Gateway history stream
personaId               behavior, voice, and avatar configuration
avatarSessionId          ephemeral provider instance
responseId              one Qwen assistant response and avatar turn
```

The provider never owns conversation history. A provider restart creates a new
`avatarSessionId` without changing `conversationSessionId`.

Different personas may use shared or isolated history. For genuinely different
characters, the recommended default is one `conversationSessionId` per
`personaId`; `ownerId` remains unchanged.

## 10. Failure and Safety Semantics

Before first avatar media is played:

- Provider failure may fall back to the complete buffered PCM from byte zero.

After avatar media starts:

- Provider failure cancels the current turn.
- The Gateway does not switch audio source in the middle of a sentence.
- A later turn may begin in explicit audio-only mode.

For interruption or content filtering, the Gateway:

1. Terminates the active Realtime response.
2. Increments the local response/avatar generation.
3. Sends `interruptTurn` without waiting indefinitely for acknowledgement.
4. Stops and clears unpublished media.
5. Ignores every late provider event from the prior generation.
6. Returns the foreground session to a usable state.

This preserves the existing requirement that a policy violation cancels only the
invalid turn and does not leave the session stuck.

## 11. Reuse Policy

- Pin OpenAvatarChat and SoulX-FlashHead to explicit revisions.
- Prefer OpenAvatarChat public component APIs and official deployment assets.
- Add only a thin adapter around the Avatar component.
- Do not copy the Avatar processor into qwen-audio-agent.
- If upstream lacks a necessary hook, prefer a small upstream contribution.
- If a fork is unavoidable, keep the patch set minimal and independently
  documented.
- Keep all Python, CUDA, checkpoint, and OpenAvatarChat-specific dependencies in
  the sidecar environment.

## 12. Milestones

### M0: Contract and Architecture Freeze

Deliverables:

- Provider SPI and capability schema.
- Public digital-human protocol extension.
- Private control event schema, binary audio framing, ordering, and generation
  rules.
- Realtime-to-provider event mapping.
- Failure, interruption, content-filter, and fallback state tables.
- Contract fixtures that are independent of OpenAvatarChat.

Exit criteria:

- Gateway, client, and provider responsibilities are unambiguous.
- A provider can be replaced without changing Realtime model integration.
- No OpenAvatarChat type appears in the public or core provider interface.
- Existing non-avatar clients remain protocol-compatible.

### M1: Mac-Runnable End-to-End Mock

Deliverables:

- `DigitalHumanOrchestrator` connected to real Qwen Realtime output events.
- Provider client and a separate Mock Provider runnable on the Mac.
- Example client that connects only to Gateway.
- Deterministic placeholder avatar output driven by actual Realtime audio.
- Configurable first-frame delay, failure, stall, interruption, and stale-output
  scenarios.
- Audio-only fallback before first media.

Exit criteria:

- One command starts Gateway, Mock Provider, and example dependencies locally.
- User microphone input produces Qwen Realtime text/audio and a visibly speaking
  placeholder avatar.
- The client never opens a provider connection.
- User interruption and content filtering settle the active turn without
  freezing the session.
- Provider restart and startup failure reach a documented terminal or fallback
  state.
- Ordinary audio mode continues to work with the provider disabled.

### M2: OpenAvatarChat Avatar Provider on GPU

Deliverables:

- Thin `OpenAvatarChatAvatarProvider` sidecar adapter.
- OpenAvatarChat Avatar processor running with SoulX-FlashHead Lite.
- Streaming 24 kHz PCM ingestion and stateful inference resampling.
- Idle/speaking transitions, timestamped media, interruption, and generation
  invalidation.
- Gateway media adapter for the selected private provider transport.
- Reproducible GPU deployment manifest with pinned revisions.

Exit criteria:

- The M1 client and Gateway switch from Mock to OpenAvatarChat using only
  configuration.
- OpenAvatarChat ASR, LLM, and TTS are not started.
- The provider begins processing before the full response is available.
- Sustained output meets real time at the declared resolution and concurrency.
- Initial engineering targets are measured: 25 FPS, absolute A/V skew below
  80 ms, Renderer startup p95 below 1.5 seconds, and interruption settlement
  below 250 ms on the declared hardware profile.
- Repeated create, speak, interrupt, and close cycles do not leak per-session GPU
  memory or replay stale frames.

### M3: Persona and Production Hardening

Deliverables:

- Three allowlisted persona configurations.
- Explicit shared/isolated history policy.
- Authentication between Gateway and provider.
- Bounded queues, overload handling, quotas, and readiness probes.
- End-to-end timing, fallback, cancellation, A/V skew, and GPU metrics.
- WebRTC network deployment, including TURN where required.
- Provider rolling restart and drain behavior.

Exit criteria:

- Persona switching cannot leak media or history across personas.
- Provider unavailability degrades predictably without affecting ordinary
  Realtime sessions.
- No public request can select arbitrary model paths or avatar assets.
- Operational dashboards identify latency by Gateway, queue, inference, and
  media-publication stage.
- Load tests prove the declared per-GPU concurrency without unbounded latency or
  memory growth.

### M4: Reusable Provider Ecosystem

Deliverables:

- Provider authoring guide and compatibility test kit.
- A second minimal provider or test implementation proving replaceability.
- Version negotiation and deprecation policy for the provider protocol.
- Deployment and licensing documentation.

Exit criteria:

- A provider implementation can pass contract tests without importing Gateway
  internals.
- Adding a provider does not require changes to the Qwen Realtime adapter.
- The OpenAvatarChat provider remains an implementation choice rather than a
  core architectural dependency.

## 13. Recommended First Implementation Slice

Implement M1 in this order:

1. Freeze provider messages and response/generation invariants.
2. Implement the Mock Provider before any OpenAvatarChat integration.
3. Connect the orchestrator to existing Qwen Realtime text/audio output events.
4. Add the Gateway-owned digital-human session extension.
5. Add the example client and placeholder media presentation.
6. Exercise interruption, content filtering, startup failure, provider restart,
   and stale-output scenarios.

This sequence validates the architectural boundary on the Mac while leaving all
GPU and OpenAvatarChat work isolated to M2.

