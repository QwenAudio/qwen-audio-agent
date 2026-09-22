# Gateway Client Protocol

> Status: **Stable 7.0**<br>
> Wire version: **7.0.0**<br>
> Roadmap: [GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)<br>
> Current implementation sources of truth: `shared/protocol/gateway-client-protocol.mjs`, `server/src/client/client-event-router.mjs`, `server/src/client/client-command-runtime.mjs`, `shared/protocol/realtime-events.mjs`, `shared/protocol/gateway-events.mjs`, and `server/src/core/gateway-protocol.mjs`

This specification defines the implemented northbound boundary between qwen-audio-agent's Gateway and one active Client Environment per authenticated owner. Current first-party clients use wire version 7.0. Legacy `connect` and runtime REST routes remain compatibility aliases, not entry points for new clients. The health contract and wire protocol are versioned separately; see the [Gateway contract](contract.md).

## 1. Product boundary

The core logical architecture consists of the **Frontend Agent, Orchestration Runtime, and Backend Agent**. This protocol defines client access to the service, not a different component model. See the [Architecture Overview](architecture/overview.md).

- The **Frontend Agent** uses a realtime model, context, and tools to understand input and compose responses.
- The **Orchestration Runtime** manages tasks, permissions, sessions, event routing, result delivery, and recovery, reaching the backend through `BackendPort`.
- The **Backend Agent** is the user's execution environment, integrated through an ACP, A2A, or custom adapter.

The **Gateway** hosts the runtime and frontend/backend integrations as a service, providing authentication, connection management, and this protocol's entry point. The **Client Environment** owns I/O, rendering, playback, local UX, sensors, user behavior, and environment actions, and communicates with the Gateway through this protocol. References to Gateway behavior below include its hosted runtime behavior; they do not move business logic into transport.

TUI, WebUI, and Desktop Orb are first-party reference clients. OpenCode, Qwen Code, MiniMax Code, Pi, OpenClaw, remote A2A agents, and other integrations are reference backends. Neither list limits the framework.

## 2. Invariants

1. One authenticated owner has only one active Client connection at a time. The default personal deployment has one owner, so its behavior remains single-Client.
2. One WebSocket carries the Client's business traffic. A second context or observer socket is not introduced.
3. Raw audio stays on the media fast path. Only committed semantic inputs enter semantic routing.
4. Client **Events** describe what happened. Client **Actions** request that the environment do something and return a result.
5. Realtime Tool Calls are model-facing. `ClientActionPort` maps applicable Tool Calls to Client Actions.
6. Gateway decides whether an event is handled deterministically, added to model context, answered later, or answered immediately.
7. Client events cannot spoof Gateway, Task, permission, or backend lifecycle events.
8. Realtime-provider and backend-protocol wire objects never cross this boundary. The Gateway owns every public type, while deliberately aligning familiar field names and shapes with external standards where semantics match.
9. Local mute, window layout, wake mechanism, and rendering remain client concerns unless they affect shared Gateway state.
10. Existing behavior remains available through compatibility aliases until every first-party client has migrated and conformance coverage exists.

### 2.1 Access boundary

Gateway access is deliberately separate from GCP. Credentials authenticate a
principal before `session.hello`; access tokens never appear in GCP envelopes,
model context, Task events, or logs.

- Loopback access remains zero-config and the Gateway still binds to
  `127.0.0.1` by default.
- Explicit `--lan` mode binds to `0.0.0.0` but advertises only the selected
  physical-interface IPv4 `ws://` endpoint. It is for trusted LANs, never direct public exposure.
- Remote HTTP and WebSocket access requires either a configured access token or
  a revocable device token issued by the Gateway host.
- A native Client sends `Authorization: Bearer <token>` in the WebSocket handshake.
  A browser carries the same token through the WebSocket subprotocol.
- Remote browser origins must be explicitly listed in
  `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS`. Remote deployments should use a trusted
  VPN or an HTTPS/WSS reverse proxy; direct public exposure is unsupported.
- A configured token maps to one owner. The optional
  `QWEN_AUDIO_AGENT_ACCESS_KEYS` JSON array can map independent tokens to
  independent owners without changing GCP.

The local operator can run `qwenaudio gateway pair` against a running Gateway.
It directly creates one short, browser-compatible connection code containing the exact Gateway
endpoint and a revocable device token; the same code opens the WebUI. Device tokens are persisted
only as SHA-256 hashes and plaintext credentials are shown once; a native remote Client does not need
an HTTPS token exchange. The browser shell exchanges its fragment token for an HttpOnly cookie.
Local management endpoints list and revoke devices. The one-time pairing endpoints remain as a
compatibility path.

Host-management requests, including endpoint publication, device credential
creation, and device administration, are outside the interactive GCP Session.
They authenticate independently and never claim or replace the active Client
lease.

## 3. Connection and negotiation

The Client connects to `ws://<gateway>/api/realtime`. The first message is `session.hello`.

```jsonc
{
  "type": "session.hello",
  "event_id": "evt_client_1",
  "protocol": { "min": "7.0.0", "max": "7.0.0" },
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
    "session.takeover",
    "session.heartbeat",
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
  "protocol_version": "7.0.0",
  "session_id": "session_01",
  "connection": {
    "lease_generation": 7,
    "replaced": false
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
    "session.takeover",
    "session.heartbeat",
    "client.actions.desktop.presence.enter_sleep",
    "session.replay"
  ]
}
```

Rules:

- With an active Client, another Client for the same owner receives `client_occupied` and is closed by default.
- A Client that negotiated `session.takeover` may set `connection.takeover: true` in `session.hello`. Gateway closes the previous Client and grants a new, monotonically increasing lease generation.
- Reconnection from the same `client.instance_id` replaces its stale socket without requiring explicit takeover.
- Owners are independent. Each owner still has exactly one active Client.
- The lease is released when the socket closes or its heartbeat expires. Lease-generation fencing prevents a stale socket from releasing or mutating a newer lease.
- A Client that negotiates `session.heartbeat` must answer each Gateway `session.ping` with a correlated `session.pong`. Application traffic also refreshes the lease. This avoids relying on WebSocket control frames that some reverse proxies do not preserve reliably.
- No observer connection or concurrent multi-Client control exists in 7.0.
- The Client must branch on negotiated capabilities, not product versions.
- Protocol version, Client identity, and capabilities cannot change without reconnecting.
- Version 7.0 defines no `context_source`, `integration`, or observer connection role. Vehicle buses, CRM feeds, sensors, and other context sources attach to the active Client Environment through client-side adapters; that Client validates and relays information events.

### 3.1 GCP1 compatibility rollout

GCP1 implements the envelope and handshake without forking Gateway business
logic. A current 7.0 Client starts with `session.hello`; Gateway returns
`session.ready`, adds `event_id` to subsequent outbound events, and normalizes
protocol inputs into the existing internal event model. A legacy 5.x Client may
continue to start with `connect` and receives the unchanged legacy event shape.
Only capabilities with working runtimes are negotiated. GCP2 Client Event and
runtime-command capabilities, GCP3 Agent Delivery, GCP4 Client Actions, and
the GCP5 reference Client and bounded replay are implemented.

### 3.2 GCP2 runtime rollout

GCP2 adds `client.event.publish` and the Task, permission, and conversation
history commands in section 5.4 to the negotiated WebSocket. Immediate results
and errors correlate through `request_event_id`. Existing REST routes call the
same runtime command service and remain temporary compatibility aliases.

Ordinary Client information events carry text and delivery intent without registration. Only host extensions needing deterministic handling register definitions. Identity comes from the authenticated connection; information delivery and operations are separate. See sections 5.2 and 5.3.

### 3.3 GCP3 delivery rollout

GCP3 implements the provider-neutral value and all four routing modes from
section 6. Task results, low-frequency meaningful progress, permission prompts,
and Client Event projections use one `RealtimeAgentDeliveryRuntime`.
Realtime providers encode only the resulting context item and optional response;
raw Client or backend protocol objects never enter the model. Existing Task
announcement batching, safe-window retry, notification claims, and playback
acknowledgement remain the reliable lifecycle around that shared projection.

### 3.4 GCP4 Client Action rollout

GCP4 implements correlated `client.action.request/result` and the
protocol-neutral `ClientActionPort`. The current desktop supplies its own tool
catalog at handshake. Client-owned inactivity, actual presence synchronization,
and model-visible information are separate paths; see section 7. Host-defined
actions remain available to installed extensions.

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
  "text": "The user touched the cup."
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

All control messages are UTF-8 JSON text frames. Version 7.0 carries PCM audio as base64 in JSON. Optional [WebRTC media transport](gateway-webrtc-client.md) leaves semantic event routing unchanged.

## 5. Protocol planes

### 5.1 User input and media

Use OpenAI Realtime terminology where the semantics match:

| Event | Direction | Meaning |
|---|---|---|
| `input_audio_buffer.append` | C→G | Append input audio |
| `input_image_buffer.append` | C→G | Append one JPEG frame to the live visual buffer |
| `input_image_buffer.clear` | C→G | Discard any pending live visual frame |
| `conversation.item.create` | C→G | Submit text, image, file, or mixed user input |
| `response.cancel` | C→G | Interrupt the current response |
| `response.created` | G→C | Response generation started |
| `response.output_audio.delta` / `.done` | G→C | Audio output |
| `response.output_audio_transcript.delta` / `.done` | G→C | Assistant transcript |
| `response.done` | G→C | Final response state; cancellation is `response.status = "cancelled"` |

Gateway extensions include `turn.started`, `transcript.discard`, `playback.clear`, and playback receipts. `input_file` is a Gateway content-part extension, not an OpenAI Realtime standard part.

User input is authoritative user intent and opens or supersedes a user turn. Client semantic events never impersonate user input.

`input.image` and `input.image_buffer` are distinct negotiated capabilities.
The former covers turn-bound image parts in `conversation.item.create`; the
latter covers ephemeral visual frames aligned with the live audio session. A
Gateway negotiates `input.image_buffer` only when the selected Realtime
Provider transport implements it.

```jsonc
{
  "type": "input_image_buffer.append",
  "event_id": "evt_client_frame_18",
  "occurred_at": 1787803060177,
  "media_type": "image/jpeg",
  "image": "<base64-jpeg>"
}
```

Version 1 accepts JPEG only, limits the Base64 body to 256 KiB, and admits at
most one frame per second. Frames update live visual context; they do not
create a user turn, trigger a response, enter conversation history, or become
backend attachments. A client sends `input_image_buffer.clear` when the user
stops live vision or closes the camera to discard pending frames, not historical
frames already received by the model. Image buffering does not describe camera
state. Clients separately publish `media.visual_input.changed` through
`client.event.publish` to update context without triggering a reply; providers
without context injection skip the notification. Microphone mute does
not clear visual input. A transient disconnect pauses client frame transmission,
which resumes when transport is ready. Session disconnect, sleep, input suspension,
and provider replacement still clear pending visual state.

The Gateway event shape is provider-neutral. The Qwen Omni adapter maps it to
the provider image buffer, priming the audio timeline with 20 ms of silence if
no audio has arrived yet, without opening the microphone. The MiniCPM-o adapter puts
the latest frame in the next audio `input.append` as `video_frames`.

### 5.2 Client information events

Use `client.event.publish` for environment information, observations, or user
actions that are not typed/spoken input. No business-name registration is needed:

```json
{
  "type": "client.event.publish",
  "event_id": "evt_visual_1",
  "name": "media.visual_input.changed",
  "text": "The camera is off. Earlier images are historical, not a live view.",
  "delivery_hint": "context"
}
```

- `type` selects the protocol operation; `event_id` correlates its receipt and
  provides bounded, connection-identity-scoped deduplication.
- `text` is required for this self-contained form. `name` is an optional label,
  never a handler selector. Even a label such as `task.completed` cannot change
  a Task or create an internal event.
- `delivery_hint` defaults to `context` (no reply). `respond` schedules a reply;
  `interrupt` interrupts the current response before requesting a reply.
  Provider capability, connection readiness and playback policy still apply.
- Limits: 16,000 characters / 32 KiB payload, and 20 events per 10 seconds per
  source across all labels. Gateway stamps source identity from the connection.
- A correlated `client.event.publish.result` with `accepted: true` means the
  Gateway accepted the event, **not** that the model consumed or spoke it.
  This is not a durable message queue; disconnected or unavailable delivery can
  be skipped and is logged.

Gateway projects the text as client-provided context through `AgentDelivery`.
It does not expose the incoming envelope as a system instruction or execute
operations described in that text. Context-only delivery never creates a response.
With `respond`/`interrupt`, the model may respond or use its already available
tools. This does not bypass tool permissions or execute an operation by event name.

WebUI publishes camera state at actual start/stop/failure boundaries, not per
frame. It caches only the latest state and republishes it after `voice.ready`.
`input_image_buffer.clear` remains a separate buffer operation.

**Host extensions:** existing deployments that need schema-validated structured
data or deterministic handling can still install `clientEventDefinitions` in
`createGatewayApplication`. Their form is `{name, data}`, without `text`.
Unknown names fail closed. An extension owns its schema, limits, handler and
projection; `delivery_hint` cannot exceed its registered maximum. This optional
extension path is not required for ordinary information events. Mixing `text`
with `data` or `handle` is rejected; a text event can never invoke an extension.

### 5.3 Client-owned tools

Clients declare tools in `session.hello` with the `client.tools` capability:

```json
{
  "capabilities": ["client.tools", "client.presence"],
  "tools": [{
    "name": "enter_sleep",
    "description": "Hide and mute the current client when the user requests rest.",
    "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
    "response_on_success": "none"
  }]
}
```

This fragment supplements the normal handshake. Definitions use
`name` / `description` / JSON Schema `inputSchema`; this is **GCP tool
discovery and transport, not an MCP server**. Configured MCP tools retain their
existing standard MCP transport.

The catalog is connection-local, limited to 32 tools, and cannot shadow Gateway
or configured tool-source names. Disconnect/takeover removes its reachability.
The client validates arguments and owns the operation; Gateway exposes definitions
to the model and forwards calls through the existing action request/result pair:

```json
{
  "type": "client.action.request",
  "event_id": "evt_call_1",
  "name": "client.tool.enter_sleep",
  "arguments": {}
}
```

```json
{
  "type": "client.action.result",
  "event_id": "evt_result_1",
  "request_event_id": "evt_call_1",
  "status": "completed",
  "output": { "state": "hidden" }
}
```

Gateway manages capability checks, correlation, deadlines and disconnection
errors. Failures use `failed` or `unsupported` with `error.code/message`.
`response_on_success` defaults to `auto`; `none` records a successful tool
result without requesting another response. Failures still request a response.
Tool results are bounded by the shared frontend tool budget.

Host-defined actions such as `xomni.visual.capture` continue to use the same
transport for Gateway-hosted tools. They remain distinct from information events:
`client.event.publish` does not execute client actions.

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

`permission.respond.decision` accepts `task`, `always`, or `reject`: allow the
current Task and its subsequent operations until completion, failure, or cancellation;
allow subsequent requests across Tasks in the current frontend session; or reject
the current operation. Gateway owns these grants and sends per-operation decisions
to BackendPort. Grants are not persisted across Gateway restarts. Wire 7.0 replaces
`once` with `task`; clients must use the updated schema, not reinterpret “allow once.”

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

`task.progress` is change-driven and coalesces backend activity; it is not a
connection heartbeat. WebSocket Clients use `session.ping` / `session.pong` (or
WebSocket control frames for legacy clients), while the compatibility Task SSE
route writes transport-only comment heartbeats. Those comments do not enter
Task replay or the Session Journal.

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

Gateway-originated events that the frontend Agent must perceive use the same
boundary. For example, after Realtime content is rejected, the Gateway excludes
the failed turn, restores the connection, and then delivers
`realtime.content_rejected`. The model receives only a sanitized instruction to
ask the user to change topics; provider errors, error codes, and rejected source
content never enter the replacement Session.

A due reminder is likewise registered as the Gateway-owned system event
`reminder.due`. Its bounded payload contains only the reminder content, scheduled
time, recurrence, and timezone. Task and series identifiers remain in
`AgentDelivery.correlation`; they are not copied into model-visible text.

## 7. Presence and sleep

User-requested sleep: model calls the client-declared `enter_sleep` → Gateway
forwards the call → Client mutes and hides → returns a tool result. Success
does not request a follow-up response; failure can still be explained.

Automatic sleep: the Client's local idle timer expires → Client mutes and hides
itself → publishes a context-only `client.event.publish` notification. It does
not ask the model to call a tool or Gateway to hide the window by event name.

Both paths report actual state using the separate `client.presence.update` command:

```json
{
  "type": "client.presence.update",
  "event_id": "evt_presence_1",
  "state": "sleeping"
}
```

Negotiate `client.presence`; `state` is `sleeping` or `active`. This command
updates Gateway input/announcement gating. It does not hide a client or replace
model context notification. Report only actual transitions and resynchronize
current state on reconnect.

The desktop Client also publishes sleep/wake context text through
`client.event.publish` with `delivery_hint: "context"`. It retains the latest
cause in the text: idle timeout, an explicit sleep request, or waking up. All
use the same event channel, with no new tool or protocol type; the Gateway does
not execute actions based on that cause. The Client retains the latest
snapshot, deduplicates unchanged state, and resends it when Realtime reconnects,
without requesting a reply. This gives the model current presence rather than
only a historical sleep tool result.

Sleep neither cancels backend work, discards pending results, nor deliberately
disconnects Realtime. Clients own wake-up; restoring `active` resumes pending
notifications. Existing host-initiated PresenceController actions remain
available, but no longer handle automatic-sleep information events.

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

The base API is the existing WebSocket. Version 7.0 does not expose an independent HTTP, `context_source`, or integration connection that bypasses the active Client. A future deployment that needs direct machine-to-Gateway event ingestion requires an explicit protocol decision; it cannot silently become a second Client role.

## 10. Relationship to external standards

The Gateway protocol defines its own types. The following alignment is deliberate and non-normative: it helps implementers recognize familiar semantics without importing foreign wire objects.

| Gateway concept or shape | Semantic alignment | Boundary |
|---|---|---|
| `input_audio_buffer.*`, `conversation.item.create`, response and audio event names | [OpenAI Realtime](https://platform.openai.com/docs/api-reference/realtime-client-events) media, conversation, response, and cancellation vocabulary | Gateway schemas, handshake, extensions, and lifecycle remain authoritative; full wire compatibility is not claimed |
| `task_id`, `status.state`, `status.message.parts`, `artifacts[].parts` | [A2A](https://a2a-protocol.org/latest/specification/) Task, status, Message, and Artifact semantics | A2A transport, JSON-RPC objects, remote Task IDs, and Agent Card objects remain inside the A2A Backend adapter |
| normalized authorization and backend activity | ACP permission, Session update, Tool Call, and plan semantics | ACP request/update objects and Session IDs remain inside the ACP Backend adapter |
| optional read-only activity projection | AG-UI activity semantics | AG-UI is not the GCP base transport or command plane |
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

The current wire protocol's stable behavior is locked by tests covering:

- owner-scoped single-Client ownership, explicit takeover, generation fencing, release, and heartbeat expiry;
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

- Concurrent controlling Clients for the same owner, observers, and arbitrary kick semantics.
- Depending on Electron, React, CoreAudio, or a specific Client implementation in the Orchestration Runtime.
- Treating ACP as the only backend protocol.
- Allowing arbitrary Client data to become model instructions.
- Requiring every Client Event or Task progress update to reach the model or produce speech.
- Implementing wake-word detection, window layout, or local mute in the Orchestration Runtime.
- Removing recovery APIs before replay is proven reliable.
