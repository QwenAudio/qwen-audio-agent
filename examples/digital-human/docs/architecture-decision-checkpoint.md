# Architecture Decision Checkpoint

This checkpoint collects the decisions that should be accepted before M1 client
and Mock Renderer implementation begins.

## Recommended Baseline

| Area | Recommended decision | Status |
| --- | --- | --- |
| Audio route | Gateway -> Browser -> Renderer | Awaiting acceptance |
| Renderer upload | WebSocket control and PCM | Awaiting acceptance |
| Renderer playback | WebRTC synchronized audio and video | Awaiting acceptance |
| Audible source | Renderer only in digital-human mode | Awaiting acceptance |
| Mac M1 output | Mock lifecycle and placeholder visual media | Awaiting acceptance |
| Real inference | Independent Python CUDA Renderer | Awaiting acceptance |
| Model | SoulX-FlashHead Lite behind an adapter | Awaiting acceptance |
| Processor behavior | Adapt OpenAvatarChat streaming patterns, not its full stack | Awaiting acceptance |
| Persona history | One conversation session per persona by default | Product decision required |
| Persona switch | Cancel old turn and replace avatar session serially | Awaiting acceptance |
| Before-play fallback | Replay complete buffered Gateway PCM | Awaiting acceptance |
| After-play failure | Cancel turn; no mid-turn audio-source switch | Awaiting acceptance |
| Initial media target | 25 FPS, less than 80 ms absolute A/V skew | Provisional benchmark target |
| Initial startup target | Renderer p95 below 1.5 seconds | Provisional benchmark target |

## Decisions That Affect M1 Code

### 1. Renderer Route

Recommended: browser relay.

This preserves the current Gateway protocol and confines all experimental avatar
behavior to the example. Choosing Gateway-direct instead changes deployment,
authentication, buffering, and playback-receipt ownership and should be decided
before implementation.

### 2. Mac Mock Fidelity

Recommended: Mock implements the exact control lifecycle and timing events, but
uses a deterministic animated placeholder instead of pretending to run the
FlashHead model.

The Mock should support configurable first-frame delay, playback duration,
failure, stall, interruption, and stale-packet scenarios. This validates the
browser state machine rather than only demonstrating a happy-path animation.

### 3. History Policy

Recommended for three genuinely different characters: isolated history.

The stable `ownerId` is retained. The desktop client stores one
`conversationSessionId` for each `personaId`. Shared history remains an explicit
configuration option if the three skins are only appearances of one assistant.

### 4. Media Implementation Sequence

Recommended:

1. Implement protocol, state machine, and deterministic Mock over WebSocket.
2. Validate interruption, fallback, persona switching, and receipt mapping.
3. Add WebRTC media output behind the same Renderer interface.
4. Replace the Mock adapter with the Python CUDA FlashHead adapter.

This sequence does not redefine the final architecture. It isolates protocol and
state-machine failures before GPU and WebRTC complexity are introduced.

## Decisions Deferred Until Measurement

- Minimum FlashHead audio window and overlap strategy.
- Number of warm personas retained per GPU worker.
- Sessions per GPU and worker scheduling policy.
- Video resolution and codec profile.
- WebRTC TURN topology for non-local deployments.
- Whether Renderer warmup begins at application launch or persona selection.

These do not change the external Renderer lifecycle and may be tuned after M2
baseline measurements.

## Explicit Non-Goals

- Replacing qwen-audio-agent ASR, LLM, tools, TTS, or history management with
  OpenAvatarChat equivalents.
- Running SoulX-FlashHead Lite inference on the Apple Silicon development Mac.
- Sending prompts, transcripts, or conversation history to the Renderer.
- Encoding skin identity by changing `ownerId`.
- Treating `audio.done` as proof that playback completed.
- Playing Gateway PCM and Renderer audio at the same time.

## Approval Gate

M1 implementation may begin when the following are confirmed:

- Browser relay is accepted for M1 and M2.
- WebSocket upload plus eventual WebRTC playback is accepted.
- The Mock is allowed to use deterministic placeholder visuals.
- The default history policy is selected as `isolated` or `shared`.
- Renderer-only audio and the documented failure policy are accepted.

