# Digital Human Example

[Chinese overview](README_ZH.md)

Status: design proposal awaiting review. No runnable demo or installation scripts
are delivered yet. Baseline: Gateway WebRTC PR #465, main commit `9ad6348f`.

The Gateway remains the client's only integration endpoint. A replaceable
`DigitalHumanProvider` consumes assistant reply audio, with optional text, and
produces avatar media. ASR, LLM, TTS/S2S, tools, and history stay outside it.

The first real demo reuses OpenAvatarChat's FlashHead Avatar processor with
SoulX-FlashHead Lite in an independent Python GPU service. LiveAvatar Avatar Only
(LITE) is a second contract reference, not a required demo integration.

## Design and implementation handoff

1. [Architecture and scope](docs/design.zh.md)
2. [Provider contract and concrete mappings](docs/provider-contract.zh.md)
3. [OpenAvatarChat implementation plan and acceptance](docs/implementation-plan.zh.md)

All three documents are proposals, not implemented framework APIs. Other design
files in this directory are historical context and are superseded by this set.

## Dependency boundary

- Framework: small provider-neutral extension points, no new third-party dependency.
- Example: provider adapters, its own Node/Python manifests and locks, tests, assets,
  and optional WebRTC extension installation.
- GPU host: pinned OpenAvatarChat/FlashHead sources, CUDA environment, and weights.
- Mac: the planned mock validates actual WebRTC audio/video without CUDA.

Default WSS and ordinary WebRTC audio behavior must remain unchanged. Installing
the framework must not install, download, or start this example or its models.
