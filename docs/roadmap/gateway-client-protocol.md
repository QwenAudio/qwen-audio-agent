# Gateway Client Protocol Roadmap

> Status: proposal
>
> Tracking: [GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)
>
> Spec: [Gateway Client Protocol](../gateway-protocol.md)

## Goal

Complete qwen-audio-agent's remaining public architecture boundary. `BackendPort` already isolates Gateway from ACP, A2A, and custom Backend Agents. This roadmap isolates Gateway Core from TUI, WebUI, Desktop Orb, and future Client Environments.

The resulting framework has three replaceable edges:

```text
Client Environment
        ↕ Gateway Client Protocol / ClientPort
Gateway Core
        ├─ RealtimeProvider
        ↕ BackendPort
Backend Agent
```

## Current baseline

The repository already has:

- one WebSocket carrying voice, text, playback receipts, Task events, and state, while some runtime commands still use internal REST/SSE routes;
- shared event constants and Zod message schemas;
- a dedicated user-input runtime;
- normalized BackendPort events and Task projections;
- provider-neutral result and permission injection primitives;
- Task announcement queuing, retry, and playback acknowledgement;
- first-party WebUI, TUI, and Desktop clients.

The remaining gaps are:

- Client dispatch is still concentrated in `realtime-gateway.mjs`;
- desktop capabilities and sleep behavior still appear as special cases;
- no generic Gateway-to-Client action/result contract exists;
- first-party Clients still use internal REST/SSE aliases for some Task control, permission, conversation-history, and recovery flows;
- user input, Task announcements, permissions, and Gateway triggers do not yet share one semantic event/delivery boundary;
- replay, full first-party migration, and a complete Client conformance suite are not implemented yet.

## Architectural rules

1. Keep one active Client per Gateway.
2. Keep raw media off the semantic event router.
3. Keep user input, Client Event, Task event, and Client Action authority distinct.
4. Let Gateway policy decide model visibility and response timing.
5. Project semantic events into provider-neutral Agent Delivery values before provider encoding.
6. Derive model-visible Client tools from negotiated Client Action capabilities.
7. Use one WebSocket runtime control plane; keep REST for discovery, health, static configuration, and host management.
8. Own every public Gateway type while deliberately aligning familiar field names and payload shapes with external standards where semantics match.
9. Keep context sources behind the single active Client instead of adding a second connection role.
10. Keep every stage backward compatible until all first-party clients have migrated.
11. Land every stage as a separately reviewable PR linked to issue #251.

## GCP0 — Freeze the contract

- [x] Merge the bilingual protocol spec and this roadmap.
- [x] Record current 5.x aliases and characterization coverage.
- [x] Add the protocol documents to the public contract index.
- [x] Freeze the standard-alignment mapping, WebSocket runtime command plane, and single-Client context-source decision.

Exit criteria: terminology, single-Client ownership, Event versus Action semantics, routing modes, sleep convergence, and migration policy are reviewable in one place.

## GCP1 — Envelope, handshake, and capabilities

- [x] Add 6.0 envelope schemas for `event_id`, `request_event_id`, and replay `sequence`.
- [x] Add `session.hello` / `session.ready` negotiation.
- [x] Add capability constants for Client Event, Client Action, and replay.
- [x] Add capability constants for Task commands, permission decisions, and conversation history.
- [x] Keep 5.x `connect` and event aliases working through a normalization layer.
- [x] Publish shared parser and Client SDK helpers.

Exit criteria: a 5.x and a 6.0 reference Client can connect to the same Gateway without divergent business logic.

## GCP2 — Client Event ingress and runtime commands

- [x] Add the Client Event definition registry.
- [x] Add `GatewayEventRouter` and `client.event.publish/result`.
- [x] Add WebSocket schemas and handlers for `task.create/get/list/cancel`, `permission.respond`, and `conversation.history`.
- [x] Keep each immediate command result correlated by `request_event_id`; publish later Task and permission changes through the normal event stream, which becomes replayable in GCP5.
- [x] Stamp trusted source identity at the connection boundary.
- [x] Enforce schema, size, rate, retention, deduplication, and coalescing policy.
- [x] Add `desktop.presence.sleep_requested` as the first end-to-end event.

Exit criteria: a Client can publish a registered environment or user-behavior event without pretending it is user text or adding a new Gateway branch, and first-party runtime commands have a WebSocket replacement for their internal REST path.

## GCP3 — Agent Delivery

- [x] Define provider-neutral `AgentDelivery` and the `handle`, `context`, `respond`, and `interrupt` routing modes.
- [x] Add context-only injection to each Realtime Provider.
- [x] Extract shared delivery serialization and provider projection while retaining the Task path's blocking, retry, and playback acknowledgement lifecycle.
- [x] Route meaningful Task, permission, Gateway, and Client event projections through the shared delivery runtime.
- [x] Keep high-frequency progress and media off the model path.

Exit criteria: one event can update Gateway/UI only, update model context silently, or produce exactly one safe Realtime response without provider-specific Gateway code.

## GCP4 — Client Action port

- [x] Add `ClientActionPort` and `client.action.request/result`.
- [x] Advertise Client Action capabilities during handshake.
- [x] Expose action-derived Realtime tools only when supported.
- [x] Migrate `enter_sleep` from `requestClientState()` to the shared action path.
- [x] Add one idempotent `PresenceController` for user-requested, automatic, timeout, and duplicate sleep requests.
- [x] Mark sleeping only after a successful Client Action result.

Exit criteria: Realtime Tool Calls and Gateway fallbacks use one action/state machine, and Gateway Core no longer knows how Desktop hides its window.

## GCP5 — Reference clients, replay, and stabilization

- [x] Migrate WebUI, TUI, and Desktop to the shared reference Client SDK.
- [x] Add bounded replay and reconnect recovery.
- [x] Migrate Task control, permission decisions, conversation history, and Task event recovery away from internal REST/SSE aliases.
- [x] Run one conformance suite against all first-party clients.
- [x] Update `docs/contract.md` and its Chinese counterpart with locked capabilities and tests.
- [x] Deprecate old aliases for at least one announced release before removal.
- [x] Mark the 6.0 specification stable only after the replacement path is proven.

Exit criteria: first-party clients contain presentation and environment behavior but no reconstructed Gateway state machine; Gateway contains no first-party Client implementation branch.

## PR policy

- Do not combine protocol-version migration, Event ingress, Agent Delivery, and Client Action migration in one PR.
- Every PR links issue #251 and identifies its GCP stage.
- Every new public event ships with Schema, parser, negative tests, capability behavior, and documentation.
- Existing first-party behavior remains green before compatibility aliases are removed.
- No stage may leak Realtime-provider, ACP, A2A, Electron, React, or CoreAudio wire objects across a public port. Semantic field-name and payload-shape alignment documented by the Gateway specification is allowed.
