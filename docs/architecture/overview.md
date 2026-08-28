# Architecture Overview

qwen-audio-agent is a realtime voice runtime that keeps AI agents talking,
working, and present. It is organized as three layers with exactly two
protocol surfaces between them.

![Three-layer architecture](../qwen-audio-agent-three-layer-architecture-en.png)

## The three layers

1. **Client — the environment.** TUI, WebUI, the desktop orb, or your own
   client. The client owns I/O and presentation, publishes environment
   state (window focus, presence, sleep/wake), and carries user signals.
   How the user wakes the assistant (wake word, hotkey, tap) is entirely a
   client concern. Clients hold no memory; they only forward signals.

2. **Gateway — the conversation layer and the state plane.** Two parts
   share one process:
   - The **Realtime frontend** is a lightweight voice agent: full-duplex
     speech, instant answers, and a deliberately small set of conversation
     tools, including search, memory, reminders, and work control.
   - The **Gateway control plane** is deterministic — no additional LLM sits
     in the routing path. It owns the task ledger, permission arbitration,
     announcement policy, and the injection defense between frontend and
     backend.

3. **Backend — the execution layer.** Anything behind the `BackendPort`:
   an ACP agent (OpenCode, OpenClaw, Qoder, Qwen Code, Kimi Code, Claude
   Code, Codex, DeepSeek, Pi, or your own), a remote A2A agent, or a
   custom adapter built with the Backend Adapter SDK. ACP integrations keep
   a persistent coordination Session for continuous work; the backend's
   internal tools, skills, and sub-sessions are backend-private and never
   become new layers.

## Two protocol surfaces, nothing else

- **Client ↔ Gateway** — the [Gateway contract](../contract.md) and the
  [client protocol](../gateway-protocol.md): typed events over a single
  WebSocket.
- **Gateway ↔ Backend** — the `BackendPort`. Protocol details stay inside
  ACP, A2A, or custom adapters; launch and capability behavior lives in
  registered drivers. See [Supported backends](../backends/overview.md)
  and the [Backend Adapter SDK](../reference/backend-adapter-sdk.md).

Adapting the runtime to a new scenario means swapping the client (the
environment) and the backend (the tools for that environment). The Gateway
changes only through declarative seams: persona files, announcement
policy, frontend MCP tools and OpenAPI operations, and knowledge/memory
providers. See the [scenario examples](../scenarios/smart-cockpit.md).

## The nonblocking loop

When a request needs real work, the frontend calls `spawn_thinking` and
the conversation continues immediately — the work runs as an async task in
the backend session, and its result flows back into the same conversation
at a safe insertion point. Nothing in the voice path ever waits for the
backend.

## Read next

- [Deep dive](deep-dive.md) — the product-boundary invariants: realtime
  tool surface, session ownership, work states, result delivery, process
  ownership, and the review checklist.
