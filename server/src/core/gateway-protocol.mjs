// Contract surface an external client (desktop app, CLI, WebUI, or a platform
// integrator) may rely on when talking to this Gateway.
//
// Versioning: bump the minor for an additive capability and the major for a
// breaking change to any HTTP endpoint or Realtime event named in
// GATEWAY_CAPABILITIES. Clients should branch on a capability rather than
// compare product versions, so a Gateway that predates a feature degrades
// instead of failing.
//
// Every capability listed here is locked by a test (see docs/contract.md);
// anything not listed is internal and may change in any release.
//
// 5.6.0 adds a provider-neutral frontend memory control plane for replaceable
// clients to list and edit the same documents used by Realtime.
// 5.5.0 adds the GCP5 reference Client SDK, bounded Task-event replay, and
// migrates first-party task/history/permission recovery to the WebSocket.
// 5.4.0 adds GCP4 ClientActionPort request/result correlation and the shared
// presence state machine used by Realtime tools and Gateway sleep triggers.
// 5.3.0 adds GCP3 provider-neutral AgentDelivery routing for Client Events,
// Task results and progress, and permission prompts.
// 5.2.0 adds GCP2 Client Event ingress and WebSocket runtime commands for
// Tasks, permissions, and conversation history while retaining the existing
// REST paths as migration aliases.
// 5.1.0 adds the opt-in 6.0 Gateway Client Protocol handshake and versioned
// envelope while preserving every 5.x Client event as a compatibility alias.
// 5.0.0 removes the backend-controlled Task presentation envelope. Backend
// outcomes now expose factual `content` plus optional typed `artifacts`; the
// frontend Chatbot owns spoken expression and each Conversation Client owns
// rendering. It also publishes the existing Realtime event model as the
// replaceable Conversation Client boundary.
// 4.0.0 replaces the dual workId/jobId Task identity with one short `id`
// (`task_id` in model tool results) and adds task.updated snapshots for
// normalized backend messages and artifacts.
// 3.1.0 adds bounded citations to final assistant transcript events.
// 3.0.0 gives public Tasks A2A-aligned work states and first-class artifact
// and authorization values. This replaces the 2.x `active`
// state and opaque result metadata, so event consumers must branch on the
// capability below before reading the new fields.
// 2.1.0 adds an opt-in AG-UI projection while preserving the native stream.
// 2.0.0 succeeds the 1.x line of the feat/embedded-gateway-host-contract
// fork (last 1.7.0). The major bump is semantic, not cosmetic: capabilities
// that line advertised (gateway.embedded-lifecycle, gateway.self-terminate,
// desktop.settings-window, …) are not part of this contract, and a removed
// capability is a breaking change. Hosts migrating from the fork must branch
// on the capability list below, never on the version number.
export const GATEWAY_PROTOCOL_VERSION = '5.6.0'

export const GATEWAY_CAPABILITIES = Object.freeze([
  // The Gateway statically hosts web/dist at its own origin, so a client may
  // point a webview at the Gateway URL without extra configuration.
  'web.same-origin-ui',
  // The Gateway serves imported orb skins at /skins/<id>/ on its own origin,
  // so the orb page's same-origin asset fetches work for an embedding host
  // without a separate static server.
  'web.skin-assets',
  // A lease in the config directory names the running instance (origin,
  // instanceId, pid) and /api/health echoes gatewayInstanceId, so a client can
  // locate an instance without port bookkeeping and never mistakes a foreign
  // process on the same port for this Gateway.
  'gateway.instance-lease',
  // The Gateway refuses to start while required realtime credentials are
  // missing, reporting what is missing instead of serving an instance whose
  // voice cannot work.
  'gateway.setup-gate',
  // This package owns configuration persistence: createSettingsStore keeps
  // settings in the config directory, and a host names no setting and no file
  // of its own.
  'gateway.settings-store',
  // qwen-audio-agent/electron: a CommonJS entry an Electron main process can
  // require, which loads every ESM contract.
  'host.electron-entry',
  // qwen-audio-agent/gateway-process: GatewayProcess forks, awaits the
  // readiness report, restarts, and tells a planned exit from a crash. The
  // desktop app runs the same implementation.
  'host.gateway-process',
  // POST /api/input/suspend|resume, GET /api/input; the Gateway relays the
  // suspension to clients through input.suspend/input.resume.
  'input.suspend-protocol',
  // input.suspend also clears playback so host recording stays clean.
  'input.suspend-clears-playback',
  // A suspension expires on its own when the holder never sends resume.
  'input.suspend-ttl',
  // Clients confirm a suspension with input.suspend.ack.
  'input.suspend-ack',
  // GET /api/tasks/:id/events?format=ag-ui projects the existing public Task
  // stream into AG-UI ACTIVITY_SNAPSHOT events. The default stream is
  // unchanged.
  'tasks.ag-ui-event-stream',
  // Native Task events expose A2A-aligned submitted/working/auth_required
  // states plus factual results, typed artifacts and authorization values.
  'tasks.structured-results-authorization',
  // Every public Task has one short `id`; task.updated carries incremental
  // backend messages and artifacts without exposing adapter protocol objects.
  'tasks.unified-id-updates',
  // Final assistant transcript events may carry bounded, normalized citations
  // collected from frontend retrieval tools during the same user turn.
  'messages.citations',
  // GET/PATCH /api/memory lists and edits the provider-backed frontend memory
  // documents used by Realtime; no storage implementation leaks to clients.
  'frontend.memory-control',
  // WS /api/realtime plus the published event constants and schemas form the
  // replaceable Conversation Client boundary for audio, text, multimodal
  // input, transcripts, playback receipts, voice state and Task projections.
  'realtime.conversation-client-v1',
  // session.hello/session.ready negotiate the stable 6.0 Client protocol;
  // 5.x connect and event names remain compatibility aliases through one
  // normalization layer.
  'realtime.gateway-client-protocol-v6-handshake',
  // Negotiated 6.0 clients can publish registered Client Events and execute
  // Task, permission, and conversation-history runtime commands over the same
  // WebSocket. Immediate results and errors correlate through request_event_id.
  'realtime.gateway-client-protocol-v6-runtime-commands',
  // Semantic Client, Task and permission events are projected into one
  // provider-neutral AgentDelivery runtime with handle/context/respond/
  // interrupt modes before any Realtime-provider encoding occurs.
  'realtime.gateway-client-protocol-v6-agent-delivery',
  // Gateway-to-Client environment operations use correlated action
  // request/results. enter_sleep is capability-gated and commits Gateway
  // sleeping only after the active Client reports a successful transition.
  'realtime.gateway-client-protocol-v6-client-actions',
  // The shipped reference Client owns handshake, correlation, Actions and
  // reconnection recovery. Replayable Task pushes carry monotonic sequence
  // numbers and session.replay provides a bounded page after a cursor.
  'realtime.gateway-client-protocol-v6-reference-client-replay',
  // The orb shell contract ships: qwen-audio-agent/orb/preload plus
  // orb/main's bindOrbShell, so a host may run the floating orb form.
  'desktop.orb-shell',
  // qwen-audio-agent/orb/window owns the orb window recipe: createOrbWindow
  // applies it and hands back a handle whose destroy() is the host's
  // synchronous teardown path.
  'desktop.orb-window-factory',
  // qwen-audio-agent/orb/placement covers the default anchor, display
  // clamping and drop persistence.
  'desktop.orb-placement',
  // The orb's position is remembered by this package (settings store
  // ui-state) when a configDir is given.
  'desktop.orb-position-store',
  // qwen-audio-agent/skin-store: importing, listing, removing and resolving
  // orb skins is a published library surface.
  'desktop.skin-store',
])
