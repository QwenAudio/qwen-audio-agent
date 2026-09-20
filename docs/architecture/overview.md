# Architecture Overview

qwen-audio-agent connects realtime conversation with asynchronous execution.
Its logical components and service deployment describe different aspects of the architecture.

## Core logical architecture

| Component | Responsibility | Boundary |
| --- | --- | --- |
| Frontend Agent | Understand input, converse naturally, call chat tools or `spawn_thinking`, and compose responses from results. | Combines a realtime model, instructions, context, and tools; does not handle backend-native protocols or execution details. |
| Orchestration Runtime | Manage task lifecycles, permissions, sessions, events, and result delivery so work and conversation can proceed together. | Runs scheduling and policy in code, without adding a coordinating model or choosing the backend's internal execution steps. |
| Backend Agent | Work in its own execution environment with its own model, tools, MCP servers, and Skills. | Connects through `BackendPort`; ACP, A2A, or custom protocol details stay inside the adapter. |

These are three logical components, not three required processes. Backend sub-agents and independent Sessions do not add core architecture layers.

## Gateway and clients

**The Gateway is the framework's service host.** It assembles the Orchestration Runtime and frontend/backend integrations, and provides listening endpoints, authentication, connection management, and protocol entry points. The runtime describes how the system works; the Gateway describes how those capabilities are served. The Gateway is not itself a protocol: clients use the Gateway Client Protocol.

**A client is an interaction and environment endpoint, not the Frontend Agent.** Desktop, WebUI, TUI, mobile, and custom clients own I/O, presentation, user actions, and environment events. Wake words, hotkeys, windows, and local devices belong to clients; long-term memory belongs to the memory module integrated with the runtime.

Desktop can start its bundled Gateway or, like mobile, WebUI, and TUI, connect to a separately deployed Gateway. The backend can be a managed local process or an external service supported by its adapter. These deployment choices do not change the core component responsibilities.

## Interface boundaries

- **Client ↔ Gateway** — the [Gateway contract](../contract.md) and the
  [client protocol](../gateway-protocol.md): typed events over a single
  WebSocket by default. Optional [WebRTC transport](../gateway-webrtc-client.md)
  reuses Gateway control and lifecycle behavior.
- **Orchestration Runtime ↔ Backend** — the `BackendPort`. Protocol details stay inside
  ACP, A2A, or custom adapters; launch and capability behavior lives in
  registered drivers. See [Supported backends](../backends/overview.md)
  and the [Backend Adapter SDK](../reference/backend-adapter-sdk.md).
- **Runtime ↔ realtime model service** — the [Realtime Provider](../voice-frontends/custom-provider.md). Independent adapters handle vendor protocols, authentication, and event conversion without changing task or client semantics.

The framework also exposes persona, announcement policy, frontend MCP/OpenAPI tools, and knowledge/memory providers. Product hosts assemble these through the existing application entry point; clients connect through the Gateway. See [Extensions](../extensions.md) and [Examples](../scenarios/index.md).

## Runtime and Session terminology

- **Orchestration Runtime** is a logical framework component. Its responsibilities currently span `task/`, `orchestration/`, `voice/`, and other modules assembled by `app/`. It is neither a single class of that name nor just the `orchestration/` directory.
- A **frontend session runtime** manages one realtime conversation's model connection, context, tools, and presentation. It is part of the runtime implementation.
- A **backend coordination Session** is persistent execution context used by the ACP adapter, not the Orchestration Runtime. A2A and custom backends need not use this Session structure.

## The nonblocking loop

When a request needs backend execution, the frontend calls `spawn_thinking`.
The Orchestration Runtime acknowledges acceptance so conversation can continue.
The configured backend executes asynchronously, and results return to the same
conversation at a safe insertion point. Backend execution does not block conversation;
permissions and results are presented according to the current interaction state.

## Read next

- [Deep dive](deep-dive.md) — the product-boundary invariants: realtime
  tool surface, session ownership, work states, result delivery, process
  ownership, and the review checklist.
