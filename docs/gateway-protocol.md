# Gateway Client Protocol

> Status: **Stable 6.0**<br>
> Wire version: **6.0.0**<br>
> Roadmap: [GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)<br>
> Current implementation sources of truth: `shared/gateway-client-protocol.mjs`, `server/src/client/client-event-router.mjs`, `server/src/client/client-command-runtime.mjs`, `shared/realtime-events.mjs`, `shared/protocol/gateway-events.mjs`, and `server/src/core/gateway-protocol.mjs`

This specification defines the implemented northbound boundary between qwen-audio-agent's Gateway and one active Client Environment. Current first-party clients use the 6.0 wire protocol; health-contract 5.x aliases remain temporarily available for compatibility.

## 1. Product boundary

```text
Client Environment
        ↕ Gateway Client Protocol
Gateway Core + Realtime Frontend Agent
        ↕ BackendPort
Backend Agent
```

The three roles are intentionally independent:

- **Gateway Core** owns the Realtime frontend agent, conversation, tools, Task lifecycle, authorization, routing, presentation, and recovery.
- **Backend Agent** is the user's execution environment. Gateway reaches it only through `BackendPort`, implemented by ACP, A2A, or a custom adapter.
- **Client Environment** owns I/O, rendering, playback, local UX, sensors, client state, user behavior, and actions available in the surrounding environment.

TUI, WebUI, and Desktop Orb are first-party reference clients. OpenCode, Qwen Code, Pi, OpenClaw, remote A2A agents, and other integrations are reference backends. Neither list limits the framework.

## 2. Invariants

1. One Gateway instance accepts only one active Client connection at a time.
2. One WebSocket carries the Client's business traffic. A second context or observer socket is not introduced.
3. Raw audio stays on the media fast path. Only committed semantic inputs enter semantic routing.
4. Client **Events** describe what happened. Client **Actions** request that the environment do something and return a result.
5. Realtime Tool Calls are model-facing. `ClientActionPort` maps applicable Tool Calls to Client Actions.
6. Gateway decides whether an event is handled deterministically, added to model context, answered later, or answered immediately.
7. Client events cannot spoof Gateway, Task, permission, or backend lifecycle events.
8. Realtime-provider and backend-protocol wire objects never cross this boundary. The Gateway owns every public type, while deliberately aligning familiar field names and shapes with external standards where semantics match.
9. Local mute, window layout, wake mechanism, and rendering remain client concerns unless they affect shared Gateway state.
10. Existing behavior remains available through compatibility aliases until every first-party client has migrated and conformance coverage exists.

## 3. Connection and negotiation

The Client connects to `ws://<gateway>/api/realtime`. The first message is `session.hello`.

```jsonc
{
  "type": "session.hello",
  "event_id": "evt_client_1",
  "protocol": { "min": "6.0.0", "max": "6.0.0" },
  "client": {
    "type": "desktop",
    "version": "1.12.0",
    "instance_id": "desktop_7f3a"
  },
  "capabilities": [
    "input.audio",
    "input.text",
    "input.image",
    "playback.receipts",
    "tasks.commands",
    "permissions.respond",
    "conversation.history",
    "client.events",
    "session.output_voice",
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ],
  "locale": "zh-CN",
  "time_zone": "Asia/Shanghai",
  "connection": {
    "voice_enabled": true,
    "input_enabled": true,
    "output_enabled": true,
    "text_only": false,
    "output_voice": "longanlufeng"
  }
}
```

`connection.output_voice` is an optional session-scoped output voice preference.
The Gateway leaves its interpretation to the active Realtime Provider; when it
is absent, the Provider keeps its deployment-level default. Providers that only
accept a voice in their initial session configuration require a fresh Realtime
Session when the voice changes. At runtime the Gateway performs that upstream
rebuild while preserving the Client's GCP connection and Gateway session.

Gateway returns the selected version and capability intersection:

```jsonc
{
  "type": "session.ready",
  "event_id": "evt_gateway_1",
  "request_event_id": "evt_client_1",
  "protocol_version": "6.0.0",
  "session_id": "session_01",
  "capabilities": [
    "input.audio",
    "input.text",
    "input.image",
    "playback.receipts",
    "tasks.commands",
    "permissions.respond",
    "conversation.history",
    "client.events",
    "session.output_voice",
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ]
}
```

Rules:

- With an active Client, a new connection receives `client_occupied` and is closed.
- The owner is released when the socket closes or its heartbeat expires.
- No takeover, kick, concurrent observer, or multi-client arbitration exists in 6.0.
- The Client must branch on negotiated capabilities, not product versions.
- Protocol version, Client identity, and capabilities cannot change without reconnecting.
- Version 6.0 defines no `context_source`, `integration`, or observer connection role. Vehicle buses, CRM feeds, sensors, and other context sources attach to the active Client Environment through client-side adapters; that Client validates and relays registered semantic events.

### 3.1 GCP1 compatibility rollout

GCP1 implements the envelope and handshake without forking Gateway business
logic. A 6.0 Client starts with `session.hello`; Gateway returns
`session.ready`, adds `event_id` to subsequent outbound events, and normalizes
6.0 input aliases into the existing internal event model. A 5.x Client may
continue to start with `connect` and receives the unchanged legacy event shape.
Only capabilities with working runtimes are negotiated. GCP2 Client Event and
runtime-command capabilities, GCP3 Agent Delivery, GCP4 Client Actions, and
the GCP5 reference Client and bounded replay are implemented.

### 3.2 GCP2 runtime rollout

GCP2 adds `client.event.publish` and the Task, permission, and conversation
history commands in section 5.4 to the negotiated WebSocket. Immediate results
and errors correlate through `request_event_id`. Existing REST routes call the
same runtime command service and remain temporary compatibility aliases.

Client Event definitions are registered at Gateway composition time. The
registry owns payload Schema, size, rate, retention, coalescing, maximum route,
and an optional deterministic handler. Gateway stamps owner, Session, Client
type, and Client instance from the authenticated connection; none of those
trusted fields are accepted from event data. The first built-in definition is
`desktop.presence.sleep_requested`. GCP2 accepts, validates, retains, and
handles the event without pretending it is user input; GCP3 now projects it
through the shared Agent Delivery boundary.

A deterministic handler may use narrow effects supplied by its Gateway host,
such as selecting one deployment-owned Assistant Profile for the current
Realtime Session. The Client still sends only schema-validated identifiers:
event data never becomes instructions, and arbitrary prompt text is not an
allowed effect input.

### 3.3 GCP3 delivery rollout

GCP3 implements the provider-neutral value and all four routing modes from
section 6. Task results, low-frequency meaningful progress, permission prompts,
and registered Client Event projections use one `RealtimeAgentDeliveryRuntime`.
Realtime providers encode only the resulting context item and optional response;
raw Client or backend protocol objects never enter the model. Existing Task
announcement batching, safe-window retry, notification claims, and playback
acknowledgement remain the reliable lifecycle around that shared projection.

### 3.4 GCP4 Client Action rollout

GCP4 implements correlated `client.action.request/result` messages and a
protocol-neutral `ClientActionPort`. The active Client capability-gates
action-derived Realtime tools. `enter_sleep`, the desktop idle event,
and the legacy Gateway timeout converge on one idempotent
`PresenceController`; an action-capable Client is marked sleeping only after it
reports that the environment transition completed. The first-party desktop now
negotiates and returns Action results through `session.hello`; the 5.x
`connect` path remains only as a deprecated compatibility alias.

### 3.5 GCP5 reference Client and replay rollout

GCP5 ships the shared `GatewayClient` SDK for handshake, command correlation,
Client Actions, reconnect, and recovery. WebUI, Desktop, and TUI share one
capability profile and conformance suite. Task lifecycle pushes carry a
session-monotonic `sequence`; `session.replay` recovers bounded events missed
at disconnect, then `task.list` and `conversation.history` on the same
WebSocket reconcile final state that may have changed while offline. Media
deltas, provisional transcripts, and immediate command results are not replayed.

As of health contract `5.5.0`, `connect` and the REST Task, permission,
conversation-history, and Session-replay paths are deprecated compatibility
aliases. They will not be removed before health contract `6.0.0`.

## 4. Common event envelope

Gateway follows the flat OpenAI Realtime envelope style:

```jsonc
{
  "type": "client.event.publish",
  "event_id": "evt_client_42",
  "name": "user.object.touched",
  "data": { "object_id": "cup" }
}
```

| Field | Requirement | Meaning |
|---|---|---|
| `type` | Always | Protocol event type |
| `event_id` | Every JSON event | Stable logical-event identity; replay preserves it |
| `request_event_id` | Command results and command errors | Identifies the initiating command |
| `sequence` | Replayable server pushes | Strictly increasing within one Gateway session |
| `occurred_at` | Semantic events when known | Millisecond timestamp at the event source; Gateway records receipt time separately |

Immediate results and errors are not replayed. Media deltas, incremental transcripts, heartbeat traffic, and `session.replay.result` are also not replayed.

The naming resemblance is intentional, but the schemas in this specification are authoritative. Reusing a standard's field name or compatible shape does not import that standard's object type or claim wire compatibility.

All control messages are UTF-8 JSON text frames. Version 6.0 carries PCM audio as base64 in JSON; a future binary media capability may replace that without changing semantic event routing.

## 5. Protocol planes

### 5.1 User input and media

Use OpenAI Realtime terminology where the semantics match:

| Event | Direction | Meaning |
|---|---|---|
| `input_audio_buffer.append` | C→G | Append input audio |
| `conversation.item.create` | C→G | Submit text, image, file, or mixed user input |
| `response.cancel` | C→G | Interrupt the current response |
| `response.created` | G→C | Response generation started |
| `response.output_audio.delta` / `.done` | G→C | Audio output |
| `response.output_audio_transcript.delta` / `.done` | G→C | Assistant transcript |
| `response.done` | G→C | Final response state; cancellation is `response.status = "cancelled"` |

Gateway extensions include `turn.started`, `transcript.discard`, `playback.clear`, and playback receipts. `input_file` is a Gateway content-part extension, not an OpenAI Realtime standard part.

User input is authoritative user intent and opens or supersedes a user turn. Client semantic events never impersonate user input.

### 5.2 Client semantic events

The public, extensible Client-to-Gateway API is:

```text
client.event.publish
client.event.publish.result
```

```jsonc
{
  "type": "client.event.publish",
  "event_id": "evt_client_17",
  "occurred_at": 1787880000000,
  "name": "user.object.touched",
  "data": {
    "object_id": "cup",
    "object_name": "水杯"
  }
}
```

```jsonc
{
  "type": "client.event.publish.result",
  "event_id": "evt_gateway_31",
  "request_event_id": "evt_client_17",
  "accepted": true,
  "name": "user.object.touched"
}
```

`name` must be registered by the Gateway protocol or an installed extension. Registration defines:

- payload schema and size limits;
- transient or latest-value retention;
- deduplication or coalescing key when needed;
- default routing policy;
- deterministic handler, if any;
- provider-neutral model projection, if any;
- replay and client-presentation behavior.

Suggested namespaces include `desktop.*`, `environment.*`, `vehicle.*`, `hardware.*`, and an extension-owned prefix. Unknown names return `client_event_unsupported`; malformed data returns `client_event_invalid`.

The caller does not choose the final model behavior. An optional `delivery_hint` may be accepted for an event definition that permits it, but Gateway may downgrade and never upgrades the requested urgency.

### 5.3 Client actions

Gateway-to-Client operations use a request/result pair:

```text
client.action.request
client.action.result
```

```jsonc
{
  "type": "client.action.request",
  "event_id": "evt_gateway_51",
  "name": "desktop.presence.enter_sleep",
  "arguments": {}
}
```

```jsonc
{
  "type": "client.action.result",
  "event_id": "evt_client_52",
  "request_event_id": "evt_gateway_51",
  "status": "completed",
  "output": null
}
```

`status` is `completed`, `failed`, or `unsupported`. Failure includes a bounded `{code, message}` object. Gateway exposes an action-derived Realtime tool only when the active Client negotiated the corresponding capability.

The first implemented action is `desktop.presence.enter_sleep`. Its tool,
automatic Client Event fallback, timeout handling, and duplicate requests share
one Presence state machine. The legacy `client.state` sleeping message remains
accepted by current clients as a migration alias, but is no longer the execution
boundary.

Client Action is not a replacement for MCP, OpenAPI, ACP, or A2A. It covers capabilities owned by the connected Client Environment. Other external systems continue to use the appropriate tool or backend adapter.

### 5.4 Runtime commands and queries

The active Client uses the same WebSocket for runtime commands and queries. Each command carries an `event_id`; its immediate `<command>.result` carries `request_event_id`. Later lifecycle changes remain ordinary server pushes rather than being hidden inside the command result; `session.replay` provides bounded Task lifecycle replay.

| Command | Direction | Meaning |
|---|---|---|
| `task.create` | C→G | Explicitly create an asynchronous Task without impersonating conversational user input |
| `task.get` / `task.list` | C→G | Read one Task or a bounded filtered Task snapshot |
| `task.cancel` | C→G | Request cancellation of one Task; subsequent lifecycle events report the final state |
| `permission.respond` | C→G | Resolve the currently pending authorization request |
| `task.input.respond` | C→G | Continue the same Task with requested user input, or decline/cancel that interaction |
| `conversation.history` | C→G | Read the bounded, client-safe conversation projection |
| `session.output_voice.update` | C→G | Change this session's output voice; the result is `session.output_voice.updated` |
| `session.replay` | C→G | Replay eligible server pushes after a sequence cursor |

After negotiating `session.output_voice`, clients may call
`GatewayClient.updateOutputVoice(voice)`. Its wire request and result are:

```jsonc
{
  "type": "session.output_voice.update",
  "event_id": "evt_client_voice_1",
  "voice": "longanlufeng"
}
```

```jsonc
{
  "type": "session.output_voice.updated",
  "event_id": "evt_gateway_voice_1",
  "request_event_id": "evt_client_voice_1",
  "voice": "longanlufeng",
  "changed": true,
  "reconnecting": true
}
```

`changed` reports whether the preference changed; `reconnecting` reports
whether the Gateway is rebuilding the upstream Realtime Session with the new
voice. A Provider without session-voice support returns the correlated
`output_voice_unsupported` error, so the Client never branches on Provider name.

`permission.respond.decision` accepts `once`, `always`, or `reject`: allow only
the current operation, always allow during the current frontend session, or
reject only the current operation.

`task.create` carries an A2A-aligned `message.parts` value rather than a second plain-text-only objective field, so an explicit integration may submit text, file, or structured parts without importing an A2A Message object.

This is the Client runtime control plane. Equivalent internal REST/SSE routes remain migration aliases until every first-party Client uses the WebSocket commands and replay path. REST remains appropriate for startup discovery, health, static configuration, and host-management operations that are not part of an active Client session.

`task.create` is an explicit integration command, not the normal voice-chat path. Conversational requests still reach Task creation through the frontend Agent's tools, preserving its routing and acknowledgement behavior.

### 5.5 Gateway state and presentation

Gateway publishes normalized state; the Client renders it without reconstructing Gateway internals:

- `gateway.*` and `voice.*` for connection and frontend state;
- `response.*`, transcript, and audio events for conversation output;
- `task.*` for Task lifecycle, activity, artifacts, and notification state;
- `task.permission.*` and `task.input.*` for authorization and requested-input state;
- `playback.clear` and other explicit presentation controls.

Every public Task keeps one Gateway `task_id`. ACP Session IDs, A2A remote Task IDs, and custom-adapter identifiers remain private to `BackendPort` adapters.

Task snapshots and updates use a Gateway-owned wrapper with deliberately A2A-aligned nested shapes:

```jsonc
{
  "type": "task.updated",
  "event_id": "evt_gateway_88",
  "sequence": 41,
  "task_id": "task_42",
  "status": {
    "state": "working",
    "message": {
      "role": "agent",
      "parts": [{ "text": "正在检查磁盘空间。" }]
    }
  },
  "artifacts": []
}
```

The Gateway owns the state vocabulary and event lifecycle. The nested `status.state`, `status.message.parts`, and `artifacts[].parts` shapes aid adapter and UI reuse but are not native A2A objects.

Task progress may be pushed to the Client without being sent to the Realtime model. Gateway's event policy selects only meaningful progress, permission, requested input, completion, and failure events for model delivery. `input_required` remains an active Task state; answering it resumes the same Task rather than creating another one.

### 5.6 Receipts and decisions

| Event | Direction | Meaning |
|---|---|---|
| `playback.started` | C→G | Audible playback started |
| `playback.ended` | C→G | Audible playback completed |
| `playback.cancelled` | C→G | Playback was discarded or interrupted |
| `client.action.result` | C→G | Client action completed or failed |
| `permission.respond` | C→G | User authorization decision |
| `task.input.respond` | C→G | User answer to a pending backend question |

`response.done` means generation finished, not that the user heard the response. Delivery workflows that require audible confirmation use playback receipts.

### 5.7 Local mute and external capture ownership

Local mute stops microphone input at the Client and does not disconnect, cancel Tasks, or suppress output. It does not need a Gateway event.

External capture ownership is stronger and remains a shared control workflow:

```text
input.capture.suspend / input.capture.suspended
input.capture.resume  / input.capture.resumed
```

Suspension has a TTL. A trusted Host Contract may request it without creating another Gateway Client connection.

## 6. Internal semantic routing

Public wire types remain distinct, but committed semantic inputs enter one in-process router:

```text
committed user input ─┐
Client Event ─────────┤
Task event ───────────┼→ GatewayEventRouter
Gateway trigger ──────┘        ├─ deterministic handler
                               ├─ state/replay projection
                               ├─ Client presentation
                               └─ optional AgentDelivery
```

This router is an in-process registry and dispatcher, not a message broker. Raw audio frames and output deltas bypass it.

An optional provider-neutral `AgentDelivery` records how the Realtime frontend agent should perceive the event:

```js
{
  id: 'delivery_123',
  causeEventId: 'evt_client_17',
  origin: 'client',
  text: '用户触摸了桌面上的水杯。',
  mode: 'context',
  correlation: { eventName: 'user.object.touched' },
  presentation: { instructions: '', allowTools: false, contextTiming: 'response' }
}
```

`presentation` is optional provider-neutral response policy. It may constrain
how a response is expressed, whether the frontend Agent may call its own tools,
and whether context must be visible before a queued response; it is never a
Realtime-provider response object.

Routing modes are:

- `handle`: deterministic Gateway handling; no `AgentDelivery` is produced;
- `context`: update model context without creating a response;
- `respond`: update context and schedule a response at a safe boundary;
- `interrupt`: interrupt the current response, update context, and request a response.

`AgentDeliveryRuntime` owns user-speech blocking, response serialization, sleep deferral, retry, and playback acknowledgement. Realtime Provider adapters translate the delivery into their own wire protocol. Raw Client JSON is never pasted into a model prompt.

## 7. Presence and sleep

Both sleep modes converge on the same PresenceController and Client Action path, but only user-requested sleep requires a model Tool Call.

### User-requested sleep

```text
user input → Realtime → optional acknowledgement → enter_sleep
           → PresenceController → ClientActionPort
           → desktop.presence.enter_sleep → Client action result
           → Gateway enters sleeping
```

The model may speak before the Tool Call or call it directly. The protocol does not mandate farewell text or a playback gate. Tool failures remain Tool Call results and do not proactively trigger speech.

### Client automatic sleep

```text
client.event.publish(desktop.presence.sleep_requested)
           → GatewayEventRouter → AgentDelivery(context)
           → Realtime learns that the Client is about to sleep
             (no response and no Tool Call)
           → Gateway → PresenceController → ClientActionPort
           → Client mutes and hides → Gateway enters sleeping
```

After its local inactivity timeout expires, the Client publishes the event with bounded state such as idle duration and reason. Gateway injects it as Realtime context and then deterministically enters sleep. Automatic sleep does not depend on model generation and never asks the model to call `enter_sleep` again.

The state machine is:

```text
active → sleep_requested → sleeping
```

Only the first transition issues a Client Action. Duplicate requests reuse the pending transition or return the already-sleeping state. Gateway marks the state `sleeping` only after a successful Client action result. Sleep does not cancel backend Tasks or discard pending results.

Wake mechanism is a Client concern. Gateway retains the Realtime provider
connection while sleeping and stops forwarding Client audio. A wake event
restores presence and microphone input, then delivers pending notifications.

## 8. Replay, errors, and limits

`session.replay` pages replayable pushes by `sequence`; default page size is 50 and maximum is 200. A stale session or sequence returns an explicit error. Reliable replay must exist before equivalent REST/SSE recovery endpoints are removed.

Base error codes include:

```text
client_occupied
protocol_version_unsupported
capability_unsupported
capability_not_negotiated
bad_event
unknown_type
client_event_unsupported
client_event_invalid
client_action_unsupported
session_expired
sequence_expired
task_not_found
task_not_cancellable
permission_not_found
payload_too_large
rate_limited
internal
```

Errors never expose credentials, backend-native objects, stack traces, or sensitive local paths.

Event definitions impose payload, rate, retention, and coalescing limits. Latest-value state must replace an existing key rather than append indefinitely. High-frequency sensors publish semantic changes, not raw sample or pointer streams.

## 9. Trust and extension model

- Gateway stamps the authenticated Client identity; a caller cannot claim an arbitrary trusted source.
- `client.event.publish` cannot publish a top-level `task.*`, `permission.*`, `gateway.*`, or `response.*` event.
- Model projections mark Client Event content as an observation or environment event, not a system instruction or user command.
- Extensions register names, schemas, projectors, and policies at Gateway composition time.
- Built-in actions are capability-gated. Extension actions require an installed and trusted Client/host extension.
- One active Client may aggregate many local sensors or environment sources without opening more Gateway sockets.

The base API is the existing WebSocket. Version 6.0 does not expose an independent HTTP, `context_source`, or integration connection that bypasses the active Client. A future deployment that needs direct machine-to-Gateway event ingestion requires an explicit protocol decision; it cannot silently become a second Client role.

## 10. Relationship to external standards

The Gateway protocol defines its own types. The following alignment is deliberate and non-normative: it helps implementers recognize familiar semantics without importing foreign wire objects.

| Gateway concept or shape | Semantic alignment | Boundary |
|---|---|---|
| `input_audio_buffer.*`, `conversation.item.create`, response and audio event names | [OpenAI Realtime](https://platform.openai.com/docs/api-reference/realtime-client-events) media, conversation, response, and cancellation vocabulary | Gateway schemas, handshake, extensions, and lifecycle remain authoritative; full wire compatibility is not claimed |
| `task_id`, `status.state`, `status.message.parts`, `artifacts[].parts` | [A2A](https://a2a-protocol.org/latest/specification/) Task, status, Message, and Artifact semantics | A2A transport, JSON-RPC objects, remote Task IDs, and Agent Card objects remain inside the A2A Backend adapter |
| normalized authorization and backend activity | ACP permission, Session update, Tool Call, and plan semantics | ACP request/update objects and Session IDs remain inside the ACP Backend adapter |
| optional read-only activity projection | AG-UI activity semantics | AG-UI is not the 6.0 base transport or command plane |
| frontend tools and external services | MCP / OpenAPI tool semantics | They do not replace Client Event, Client Action, or the Gateway runtime command plane |

## 11. Migration from 5.x

1. Freeze this specification and add characterization tests for current clients.
2. Add the 6.0 envelope, handshake, capabilities, and parsers while still accepting 5.x aliases.
3. Add `GatewayEventRouter`, the Client Event registry, `client.event.publish/result`, and the WebSocket runtime command/query plane.
4. Add provider-neutral Agent Delivery and reuse current Task announcement reliability.
5. Add `ClientActionPort` and `client.action.request/result`; migrate `enter_sleep` first.
6. Migrate WebUI, TUI, and Desktop through the shared reference Client SDK.
7. Add replay and full conformance coverage; migrate Task, permission, and conversation runtime calls away from internal REST/SSE aliases.
8. Stop emitting 5.x and REST/SSE runtime aliases, then remove them only after an announced deprecation release.

Health checks, static assets, installation, and settings remain host/operations APIs and are not forced onto the business WebSocket.

## 12. Conformance requirements

The stable 6.0 behavior is locked by tests covering:

- global single-Client ownership, release, and heartbeat expiry;
- version and capability negotiation;
- `event_id`, `request_event_id`, and replay `sequence` semantics;
- user input versus Client Event authority;
- registered, unknown, malformed, duplicated, rate-limited, and coalesced Client Events;
- all four routing modes without duplicate model delivery;
- provider-neutral context-only and response delivery on every Realtime provider;
- Client Action capability gating, results, failures, timeout, and reconnect behavior;
- active and automatic sleep converging on one idempotent state machine;
- model failure fallback for Client-requested automatic sleep;
- local mute versus external capture suspension;
- Task and permission projections without backend protocol leakage;
- first-party WebUI, TUI, and Desktop behavior through one contract suite.

## 13. Non-goals

- Multi-user or multi-Client concurrency, observers, takeover, and kick semantics.
- Exposing Electron, React, CoreAudio, or a specific Client implementation in Gateway Core.
- Treating ACP as the only backend protocol.
- Allowing arbitrary Client data to become model instructions.
- Requiring every Client Event or Task progress update to reach the model or produce speech.
- Implementing wake-word detection, window layout, or local mute in Gateway Core.
- Removing recovery APIs before replay is proven reliable.
