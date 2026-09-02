# Gateway contract

This file is the single index of what an external client — the desktop app,
the CLI, the WebUI, or a platform integrating qwen-audio-agent — may rely on.
Everything not listed here (internal module paths, file layouts inside the
config directory other than what is named below, database and state file
formats) is not contract and may change in any release.

Every promise in this file is locked by a test; the table in each section
names it.

## Protocol version and capabilities

`GET /api/health` reports `protocolVersion` and `capabilities`. Clients should
branch on a capability, not compare product versions — a Gateway that predates
a feature then degrades instead of failing.

Versioning follows SemVer: the minor rises for an additive capability, the
major for a breaking change to any endpoint or event named below.

The stable 6.0 northbound boundary is documented in the
[Gateway Client Protocol](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/gateway-protocol.md) and its
[completed roadmap](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/roadmap/gateway-client-protocol.md), tracked by the closed
[GitHub issue #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251).
GCP1–GCP5 are complete: the 6.0 handshake, Client Event ingress,
runtime-command plane, Agent Delivery, Client Actions, reference Client SDK,
and bounded replay all share the same WebSocket.
This contract index remains authoritative for implemented behavior.

The current health-contract version is `5.6.0`. The additive `5.6` line exposes
a provider-neutral frontend memory control plane for replaceable clients. The
additive `5.5` line ships
the shared reference Client SDK, bounded Task-event replay, and reconnect state
recovery. First-party WebUI, Desktop, and TUI clients now pass the same
conformance suite and no longer use internal REST routes for Task control,
permission decisions, or conversation history. The additive `5.4` line adds
correlated Client Actions and the shared Presence state machine. The additive
`5.3` line adds provider-neutral Agent Delivery. The additive `5.2` line exposes
registered Client Event ingress and Task, permission, and conversation-history
commands on the negotiated 6.0 WebSocket while retaining REST compatibility
aliases. The additive `5.1` line exposes
the opt-in GCP 6.0 `session.hello` / `session.ready` handshake while preserving
the 5.x `connect` path and business event aliases. The `5.0` line removes the backend-controlled
Task `presentation` envelope. A backend returns factual `content` plus optional
typed `artifacts`; the foreground Chatbot decides how to speak, while each
Conversation Client decides how to render. The same line publishes the existing
`WS /api/realtime` event model as the replaceable Conversation Client boundary.
The `4.0` line replaces the former
`workId` / `jobId` pair with one short Task `id` (`task_id` in model tool
results) and adds incremental `task.updated` snapshots. This changes the Task
event shape and therefore raises the major version. The `3.1` line adds bounded citations to final
assistant transcript events. The `3.0` line gives native Task events
A2A-aligned `submitted`, `working`, and `auth_required` states together with
typed artifact and authorization values. It replaces the `2.x`
`active` state and opaque result metadata, so event consumers must check the
capability table below. The `2.1` line added the optional AG-UI Task event
projection without changing its default event stream. The `2.x` line succeeds the `1.x` line of the
`feat/embedded-gateway-host-contract` fork (which ended at `1.7.0`): the major
bump records that capabilities that line advertised — such as
`gateway.embedded-lifecycle` and `desktop.settings-window` — are not part of
this contract. A host migrating from the fork re-checks the capability table
below instead of assuming the old list.

| Capability | Meaning | Locked by |
| --- | --- | --- |
| `web.same-origin-ui` | The Gateway statically hosts the web UI at its own origin; a webview pointed at the Gateway URL needs no extra configuration | `test/consumer-install.test.mjs` |
| `web.skin-assets` | Imported orb skins are served at `/skins/<id>/` on the Gateway origin, so the orb page's same-origin asset fetches work without a separate static server | `test/consumer-install.test.mjs` |
| `gateway.instance-lease` | A lease in the config directory names the running instance; `/api/health` echoes `gatewayInstanceId` so a foreign process on the same port is never mistaken for this Gateway | `test/consumer-install.test.mjs` |
| `gateway.setup-gate` | An unconfigured start is refused with `QWAUDIO_GATEWAY_SETUP_REQUIRED` and a `missing` list instead of serving an instance whose voice cannot work | `test/gateway-setup.test.mjs` |
| `gateway.settings-store` | Configuration persistence is owned by this package: `createSettingsStore({ configDir })` — a host names no setting and no file of its own | `desktop/test/settings-store.test.mjs` |
| `host.electron-entry` | `qwen-audio-agent/electron`: a CommonJS entry an Electron main process can `require`, loading every ESM contract through one `load()` | `test/consumer-install.test.mjs` |
| `host.gateway-process` | `GatewayProcess` ships: forking, port fallback, the readiness handshake, restart, and telling a planned exit from a crash — the desktop app runs the same implementation | `desktop/test/gateway-process.test.mjs` |
| `input.suspend-protocol` | `POST /api/input/suspend\|resume`, `GET /api/input`; the Gateway relays the suspension to clients through `input.suspend` / `input.resume` | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-clears-playback` | Suspending also clears playback so host recording stays clean | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-ttl` | A suspension expires on its own when the holder never resumes | `server/test/input-arbitration.test.mjs` |
| `input.suspend-ack` | Clients confirm a suspension with `input.suspend.ack` (status display only — never wait for it) | `server/test/input-suspend-protocol.test.mjs` |
| `tasks.ag-ui-event-stream` | `GET /api/tasks/:id/events?format=ag-ui` projects the existing Task stream into AG-UI `ACTIVITY_SNAPSHOT` events; omitting `format` preserves the native stream | `server/test/agui-event-projector.test.mjs` |
| `tasks.structured-results-authorization` | Native Task events use A2A-aligned work states and expose factual `result`, typed `artifacts`, and `authorization`, without prescribing speech or UI | `test/gateway-event-schema.test.mjs`, `server/test/task-state.test.mjs` |
| `tasks.unified-id-updates` | A Task exposes one short `id`; `task.updated` carries adapter-normalized incremental messages and artifacts | `test/gateway-event-schema.test.mjs`, `server/test/task-manager.test.mjs` |
| `messages.citations` | Final assistant `transcript.final` events may carry normalized citations collected from frontend retrieval in the same turn | `test/gateway-event-schema.test.mjs`, `server/test/realtime-presentation-runtime.test.mjs` |
| `frontend.memory-control` | `GET/PATCH /api/memory` lets replaceable clients list and exactly edit the same provider-backed USER/MEMORY documents used by Realtime, without depending on a storage implementation | `server/test/gateway-application.test.mjs` |
| `realtime.conversation-client-v1` | `WS /api/realtime`, published event constants, and message schemas form the replaceable text/audio/multimodal Conversation Client boundary | `test/gateway-event-schema.test.mjs`, `test/custom-conversation-client.test.mjs` |
| `realtime.gateway-client-protocol-v6-handshake` | The same WebSocket accepts an opt-in 6.0 `session.hello`, returns correlated `session.ready`, negotiates implemented capabilities, and normalizes 6.0 input aliases into the existing business path | `test/gateway-client-protocol.test.mjs`, `server/test/gateway-client-handshake.test.mjs` |
| `realtime.gateway-client-protocol-v6-runtime-commands` | Negotiated 6.0 Clients can publish registered semantic Client Events and use correlated Task, permission, conversation-history, and session output-voice commands over the same WebSocket; existing REST routes call the same command service as compatibility aliases | `test/gateway-client-protocol.test.mjs`, `server/test/client-event-router.test.mjs`, `server/test/client-command-runtime.test.mjs`, `server/test/gateway-client-handshake.test.mjs` |
| `realtime.gateway-client-protocol-v6-agent-delivery` | Client Events, Task results and progress, and permission prompts cross one provider-neutral `AgentDelivery` boundary with `handle`, `context`, `respond`, and `interrupt` modes | `server/test/agent-delivery.test.mjs`, `server/test/client-event-router.test.mjs`, `server/test/realtime-provider.test.mjs`, `server/test/announcement-manager.test.mjs` |
| `realtime.gateway-client-protocol-v6-client-actions` | Correlated `client.action.request/result` messages execute Client-owned environment operations; `enter_sleep` is capability-gated and sleeping commits only after Client success | `test/gateway-client-protocol.test.mjs`, `server/test/client-action-port.test.mjs`, `server/test/gateway-client-handshake.test.mjs`, `desktop/test/enter-sleep-flow.test.mjs` |
| `realtime.gateway-client-protocol-v6-reference-client-replay` | The shared reference Client SDK owns handshake, command correlation, `updateOutputVoice()`, Client Actions, reconnect, and recovery; Task pushes use bounded `sequence` replay and WebUI, Desktop, and TUI share one conformance suite | `test/gateway-client-sdk.test.mjs`, `test/gateway-client-conformance.test.mjs`, `server/test/gateway-client-protocol-session.test.mjs`, `server/test/gateway-client-replay-buffer.test.mjs` |
| `desktop.orb-shell` | The orb form's main-process contract ships: `bindOrbShell` answers the channels the shipped preload sends | `desktop/test/orb-shell.test.mjs` |
| `desktop.orb-window-factory` | `createOrbWindow` owns the orb window recipe; its `destroy()` is the host's synchronous teardown path (renderer exit is what releases the microphone) | `desktop/test/orb-window.test.mjs` |
| `desktop.orb-placement` | `createOrbPlacement` covers the default anchor, display clamping and drop persistence | `desktop/test/orb-placement.test.mjs` |
| `desktop.orb-position-store` | The orb's position is remembered by this package (settings store ui-state) | `desktop/test/settings-store.test.mjs` |
| `desktop.skin-store` | Importing, listing, removing and resolving orb skins is a published library surface | `desktop/test/skin-store.test.mjs` |

The list itself is `GATEWAY_CAPABILITIES` in
`server/src/core/gateway-protocol.mjs`; `test/gateway-contract.test.mjs` fails
whenever a capability and this document drift apart.

## Package entry points

Only the subpaths below are contract; importing anything by its internal path
is unsupported and breaks without notice.

| Entry | Exports |
| --- | --- |
| `qwen-audio-agent/electron` | **CJS**: `load()` (every contract in one namespace), `PRELOAD_PATH` |
| `qwen-audio-agent/gateway-protocol` | `GATEWAY_PROTOCOL_VERSION`, `GATEWAY_CAPABILITIES` |
| `qwen-audio-agent/gateway-client-protocol` | GCP 6.0 envelope, handshake and runtime-command schemas, parsers, capability constants, and reference Client helpers |
| `qwen-audio-agent/gateway-client-sdk` | `GatewayClient`: WebSocket lifecycle, 6.0 handshake, request correlation, Client Actions, bounded replay, and reconnect recovery |
| `qwen-audio-agent/gateway-client-profiles` | Reference capability profiles for WebUI, Desktop, and TUI |
| `qwen-audio-agent/client-events` | Client Event definition registry, built-in definitions, routing policies, and `GatewayEventRouter` for Gateway extensions |
| `qwen-audio-agent/client-actions` | `ClientActionPort`, built-in action names, capability mapping, request/result correlation, deadlines, and in-flight deduplication |
| `qwen-audio-agent/agent-delivery` | Provider-neutral `AgentDelivery` values and routing modes |
| `qwen-audio-agent/gateway-setup` | `gatewaySetupStatus`, `assertGatewaySetup` |
| `qwen-audio-agent/gateway-process` | `GatewayProcess`, `createGatewayProcess`, `GATEWAY_READY_MESSAGE`, `DEFAULT_GATEWAY_ENTRY`, `validateGatewayOrigin`, `portInUse` |
| `qwen-audio-agent/gateway-lease` | `readGatewayLease`, `findRunningGateway`, `acquireGatewayLease` |
| `qwen-audio-agent/realtime-events` | `GatewayClientEvent`, `GatewayServerEvent`, `GatewayTaskEvent` |
| `qwen-audio-agent/gateway-events` | Gateway event Zod schemas and parsers |
| `qwen-audio-agent/ag-ui-events` | Zod schema and parser for the supported AG-UI compatibility surface |
| `qwen-audio-agent/gateway-client-state` | `createGatewayClientState`, `reduceGatewayClientState`, `acceptsGatewayVoiceState` |
| `qwen-audio-agent/settings` | `createSettingsStore` |
| `qwen-audio-agent/skin-store` | `importSkin`, `listSkins`, `removeSkin`, `effectiveOrbSkin`, `skinsDirectory`, `validateSkinPackage` |
| `qwen-audio-agent/orb/main` | `bindOrbShell`, `configureOrbWindow`, `ORB_CHANNELS` |
| `qwen-audio-agent/orb/window` | `createOrbWindow`, `orbWindowOptions`, `ORB_PRELOAD_PATH`, `ORB_WINDOW_SIZE` |
| `qwen-audio-agent/orb/placement` | `createOrbPlacement`, `ORB_PLACEMENT_MARGIN` |
| `qwen-audio-agent/orb/presence` | `DesktopPresence` |
| `qwen-audio-agent/orb/preload` | The renderer preload both orb and settings pages use |
| `qwen-audio-agent/orb/url` | `desktopOrbUrl` |
| `qwen-audio-agent/web-dist/*` | The prebuilt web assets |

All entries are ESM except `qwen-audio-agent/electron` and
`qwen-audio-agent/orb/preload`, which are CommonJS because their boundaries
demand it.

## The embedding flow

```js
const audioAgent = require('qwen-audio-agent/electron')
const api = await audioAgent.load()

const settings = api.createSettingsStore({ configDir })
if (!settings.ready()) { /* collect settings.status().missing, settings.save(...) */ }

const gateway = api.createGatewayProcess({ configDir, wakeWord: false })
const origin = await gateway.start()

const placement = api.createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: api.ORB_WINDOW_SIZE,
  loadState: () => settings.orbPosition.load(),
  saveState: state => settings.orbPosition.save(state),
})
const orb = await api.createOrbWindow({
  pageUrl: () => api.desktopOrbUrl(origin, { orbSkin: settings.load().orbSkin }),
  placement,
  partition: 'persist:my-host',
})
const presence = new api.DesktopPresence({ getWindow: () => orb.window() })
const shell = api.bindOrbShell({
  ipc: ipcMain,
  getWindow: () => orb.window(),
  presence,
  onDragEnd: () => {
    const [x, y] = orb.window().getPosition()
    placement.recordPosition({ x, y })
  },
  onQuit: () => stopPlugin(),
})

// Applying an imported skin:
api.importSkin({ source, skinsRoot: api.skinsDirectory(configDir) })
settings.save({ orbSkin: 'firefly--lingxiaotian' })
await orb.load()
```

## HTTP interface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, capability discovery and runtime status; includes `protocolVersion`, `capabilities`, `gatewayInstanceId`, `voiceConfigured`, `inputSuspension`, `voiceClients`, `backend` |
| `GET /api/memory` | List the current owner's bounded, provider-neutral frontend memory documents |
| `PATCH /api/memory` | Apply exact revision-checked edits to those documents; stale revisions return `409` |
| `POST /api/input/suspend` | Take the microphone: `{ owner, reason?, ttlMs? }`; default TTL 15 s, cap 300 s |
| `POST /api/input/resume` | Release it: `{ owner }` |
| `GET /api/input` | Current suspension status |
| `GET /api/tasks/:id/events?format=ag-ui` | Opt-in AG-UI `ACTIVITY_SNAPSHOT` stream for one Task; capability: `tasks.ag-ui-event-stream` |

Microphone suspension semantics: do not wait for the acknowledgement (a key
press that starts recording is latency sensitive — send and start recording);
idempotent per owner, a repeated suspend refreshes the deadline; multiple
owners are reference counted; every hold expires, so a crashed holder can
never silence the Gateway for good.

The AG-UI endpoint is an event projection, not a complete AG-UI agent/run
endpoint. Each Task keeps one stable `messageId`; every lifecycle update
replaces its `qwen.audio.task` activity content. The native Task stream remains
the default and existing clients receive no additional events.

`/api/tasks`, `/api/permissions/:id`, `/api/conversations/:id/messages`, and
`/api/sessions/:id/replay` are compatibility aliases as of health contract
`5.5.0`: first-party clients use the 6.0 WebSocket commands and
`session.replay`. The aliases will not be removed before health contract
`6.0.0`. Other unlisted endpoints such as `/api/backend/ui` remain internal.

## Realtime events

`WS /api/realtime?sessionId=<id>` is the public Conversation Client boundary.
Event names ship through `qwen-audio-agent/realtime-events`, and message
schemas/parsers through `qwen-audio-agent/gateway-events`; clients should use
those package entries rather than internal module paths.
`gateway.connected` and `gateway.disconnected` are client-side lifecycle
helpers used by the shared state reducer; they are not WebSocket wire events.

Legacy 5.x clients send `connect` first. That alias is deprecated as of health
contract `5.5.0` and will not be removed before `6.0.0`. A 6.0 client sends
`session.hello`, includes its connection configuration in that envelope, waits
for the correlated `session.ready`, and then uses the negotiated capabilities.
The handshake declares input/output mode,
client identity, locale/time zone, and supported input kinds. Audio input is
base64 PCM16 mono at the `inputSampleRate` reported by `voice.ready`; audio
output uses the `sampleRate` carried by each `audio.delta`. A text or multimodal
turn uses `input.message` with ordered `parts` (`text` or `file`). Task events
share the same socket but are optional for a client that only needs the
conversation surface.

| Direction | Event group | Meaning |
| --- | --- | --- |
| client → server | `connect` | Declare the client and its voice/input capabilities before submitting input |
| client → server | `input.message`, `text.message` | Submit one text or multimodal conversation turn |
| client → server | `audio.append` | Append one base64 PCM16 mono input chunk |
| client → server | `unmute`, `mute`, `input.unmute`, `input.mute` | Control voice participation or only microphone capture |
| client → server | `interrupt`, `sleep`, `wake` | Interrupt the foreground response or control explicit sleep |
| client → server | `playback.started`, `playback.ended`, `playback.cancelled` | Report client-side playback lifecycle by `responseId` |
| server → client → server | `client.action.request`, `client.action.result` | Execute a capability-gated Client Environment operation and return its correlated outcome |
| server → client | `voice.ready`, `voice.connection`, `voice.ownership`, `voice.deactivated`, `voice.sleep` | Voice connection, ownership, and sleep lifecycle |
| server → client | `turn.started`, `voice.state` | Foreground conversation-turn identity and state |
| server → client | `audio.delta`, `audio.done`, `playback.clear` | Audio playback stream and cancellation |
| server → client | `response.started`, `response.interrupted` | Response lifecycle keyed by `responseId` |
| server → client | `transcript.delta`, `transcript.final`, `transcript.discard` | User and assistant transcript lifecycle |
| server → client | `task.*` | Optional background Task snapshots, progress, authorization, and completion |
| server → client | `agent.activity`, `client.state`, `error` | Foreground activity hints, the temporary 5.x client-state migration alias, and errors |

| Direction | Event | Meaning |
| --- | --- | --- |
| server → client | `input.suspend` | Stop capturing outright (stronger than user-level mute: no capture, no wake word); carries `owner`, `reason`, `expiresAt` |
| server → client | `input.resume` | Capture may resume |
| client → server | `input.suspend.ack` | Confirms the suspension took effect on this client |
| server → client | `voice.state` | Foreground voice-turn presentation state: `idle`, `listening`, `processing`, or `speaking`; `processing` remains active across a synchronous frontend tool call until its terminal result or direct follow-up response |
| server → client | `transcript.final` | A final assistant transcript may include `citations: [{ id, title, url, snippet?, source?, published_at? }]`; capability: `messages.citations` |

### Shared client state

`qwen-audio-agent/gateway-client-state` folds public Gateway events into the
side-effect-free client state fields `connectionState`, `voiceReady`,
`voiceState`, `wakeWordActive`, `ownership`, and `currentTurnId`.
`reduceGatewayClientState(state, event)` preserves object identity for unknown
events and consistently ignores direct-model `voice.state` updates from stale
turns. Clients still own playback, microphone, and UI side effects; they should
not duplicate this protocol-state interpretation. Locked by
`test/gateway-client-state.test.mjs`.

`voice.state` describes only the foreground Realtime turn. Background Agent
work uses the Task lifecycle and must not be inferred from `processing`.
Likewise, a pending authorization is a Task interaction, not a voice state: a
client may show its Task card, and any spoken request naturally appears as
`speaking`.

## Instance lease

A running Gateway writes `gateway.lock` into its config directory:
`{ schema: "qwaudio.gateway-lock/v1", instanceId, pid, owner, state, origin,
startedAt, heartbeatAt }`. Locate an instance by reading the lease, probing
`origin`, and checking that `/api/health` echoes the same
`gatewayInstanceId` — a port reused by another process then reads as "not
running" instead of leaking a stranger's status. A clean shutdown releases
the lease. Locked by `test/consumer-install.test.mjs` and
`test/gateway-instance-lock.test.mjs`.

## Setup gate

Starting `server/src/index.mjs` without the required realtime credential is
refused before the lease is touched: the process exits non-zero and the error
names every missing key (`DASHSCOPE_API_KEY`, or the Speech-to-Speech service
address when that provider is selected). `QWEN_AUDIO_ALLOW_UNCONFIGURED=1`
opts out for harnesses that never open a voice connection. Locked by
`test/gateway-setup.test.mjs` and `test/consumer-install.test.mjs`.

## Runtime baseline

Shipped code runs on the oldest Node admitted by the `engines` range. CI runs
the suite on that version, and `test/runtime-baseline.test.mjs` fails the
build if shipped code uses an API newer than the baseline.
