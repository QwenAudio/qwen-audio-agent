# Realtime Digital Human Example

This example adds a realtime, audio-driven digital human presentation layer to
qwen-audio-agent without replacing its conversation runtime.

The intended production stack is:

```text
qwen-audio-agent
+ OpenAvatarChat's streaming FlashHead processor design
+ SoulX-FlashHead Lite
+ an independent Python GPU renderer
```

Development is intentionally split so that the client, Gateway integration,
protocol, interruption behavior, and fallback path can be built on a Mac. The
real renderer runs separately on a Linux host with an NVIDIA GPU.

## Documents

- [Architecture](docs/architecture.md)
- [Milestones](docs/milestones.md)
- [Renderer protocol](docs/renderer-protocol.md)
- [ADR-001: Renderer audio routing](docs/adr-001-renderer-audio-routing.md)

## Project status

Milestone 1 is the current target. It will provide a Mac-runnable example and a
mock renderer before any CUDA dependency is introduced.

## Non-goals

- Replacing Qwen Audio Realtime with a second ASR, LLM, or TTS pipeline.
- Importing OpenAvatarChat as another conversation runtime.
- Running SoulX-FlashHead inference on Apple Silicon.
- Sending conversation history or tool state to the renderer.
