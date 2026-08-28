---
layout: home

hero:
  name: Qwen Audio Agent
  text: Realtime voice runtime for AI agents
  tagline: "Keep your agent talking, working, and present — full-duplex voice, background tasks, and any backend: ACP, A2A, or your own adapter."
  actions:
    - theme: brand
      text: Quickstart
      link: /getting-started/quickstart
    - theme: alt
      text: Architecture
      link: /architecture/overview
    - theme: alt
      text: GitHub
      link: https://github.com/QwenAudio/qwen-audio-agent

features:
  - title: Full-duplex realtime voice
    details: Speak and interrupt naturally. Streaming speech-to-speech with barge-in, playback receipts, and transcript sync.
  - title: Bring your own agent
    details: ACP-compatible agents (Qwen Code, OpenCode, Claude, OpenClaw), remote A2A agents, or a custom adapter — all plug into the same runtime through the BackendPort.
  - title: Deterministic task plane
    details: Long-running tasks, permission arbitration, and progress announcements stay consistent across every client surface.
  - title: Multiple client surfaces
    details: TUI, WebUI, and Desktop Orb are reference clients; the client protocol lets you build your own environment.
---
