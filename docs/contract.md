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

The current version is `2.1.0`. It adds opt-in composer dictation events and
capabilities to `2.0.0`, which succeeded the `1.x` line of the
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
| `desktop.orb-shell` | The orb form's main-process contract ships: `bindOrbShell` answers the channels the shipped preload sends | `desktop/test/orb-shell.test.mjs` |
| `desktop.orb-window-factory` | `createOrbWindow` owns the orb window recipe; its `destroy()` is the host's synchronous teardown path (renderer exit is what releases the microphone) | `desktop/test/orb-window.test.mjs` |
| `desktop.orb-placement` | `createOrbPlacement` covers the default anchor, display clamping and drop persistence | `desktop/test/orb-placement.test.mjs` |
| `desktop.orb-position-store` | The orb's position is remembered by this package (settings store ui-state) | `desktop/test/settings-store.test.mjs` |
| `desktop.skin-store` | Importing, listing, removing and resolving orb skins is a published library surface | `desktop/test/skin-store.test.mjs` |
| `dictation.session-v1` | A default-off, live-process dictation session can stream composer audio to an independent ASR provider and expose visible lifecycle states | `server/test/dictation-session.test.mjs` |
| `dictation.draft-ops-v1` | Draft changes use client-owned snapshots and revision-guarded insert/replace/delete/rewrite operations | `test/dictation-protocol.test.mjs` |
| `dictation.commit-idempotency-v1` | A live client session de-duplicates `commitId` and invokes its existing composer submit path at most once | `server/test/dictation-session.test.mjs`, `web/test/dictation-client.test.mjs`, `tui/test/dictation.test.mjs` |

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
| `qwen-audio-agent/gateway-setup` | `gatewaySetupStatus`, `assertGatewaySetup` |
| `qwen-audio-agent/gateway-process` | `GatewayProcess`, `createGatewayProcess`, `GATEWAY_READY_MESSAGE`, `DEFAULT_GATEWAY_ENTRY`, `validateGatewayOrigin`, `portInUse` |
| `qwen-audio-agent/gateway-lease` | `readGatewayLease`, `findRunningGateway`, `acquireGatewayLease` |
| `qwen-audio-agent/realtime-events` | `GatewayClientEvent`, `GatewayServerEvent`, `GatewayTaskEvent` |
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
| `POST /api/input/suspend` | Take the microphone: `{ owner, reason?, ttlMs? }`; default TTL 15 s, cap 300 s |
| `POST /api/input/resume` | Release it: `{ owner }` |
| `GET /api/input` | Current suspension status |

Microphone suspension semantics: do not wait for the acknowledgement (a key
press that starts recording is latency sensitive — send and start recording);
idempotent per owner, a repeated suspend refreshes the deadline; multiple
owners are reference counted; every hold expires, so a crashed holder can
never silence the Gateway for good.

Endpoints not listed here (`/api/tasks`, `/api/timeline`, `/api/backend/ui`,
`/api/permissions/:id`, `WS /api/realtime` payloads beyond the events below)
are used by our own front ends and carry no stability promise.

## Realtime events

Event names ship as constants in `shared/realtime-events.mjs`; a client that
spells them by hand is on its own.

| Direction | Event | Meaning |
| --- | --- | --- |
| server → client | `input.suspend` | Stop capturing outright (stronger than user-level mute: no capture, no wake word); carries `owner`, `reason`, `expiresAt` |
| server → client | `input.resume` | Capture may resume |
| client → server | `input.suspend.ack` | Confirms the suspension took effect on this client |
| client → server | `dictation.start`, `dictation.pause`, `dictation.resume`, `dictation.cancel`, `dictation.stop` | Control one visible, opt-in composer dictation session |
| client → server | `dictation.audio.append` | Stream Base64 PCM16 audio only to the independent ASR session |
| client → server | `dictation.context`, `dictation.operation.ack`, `dictation.commit.ack` | Exchange an ephemeral revisioned composer snapshot and acknowledge draft/submit results |
| server → client | `dictation.state`, `dictation.transcript.delta`, `dictation.transcript.final` | Expose dictation state and non-committing ASR previews |
| server → client | `dictation.context.request`, `dictation.operation` | Request one client-owned draft snapshot and return a revision-guarded operation |
| server → client | `dictation.commit.request` | Ask the client to invoke its ordinary composer submit once for a unique live-session `commitId` |
| server → client | `dictation.error` | Report an ASR or protocol failure without falling back to the primary Realtime frontend |

Dictation events carry a per-direction monotonic `seq` and `sessionId`.
Operations carry `operationId` and `baseRevision`; commits carry `commitId`,
`revision`, and `payloadHash`. The feature is runtime-gated and is not
advertised by `/api/health` while disabled. Audio, previews, uncommitted text,
cancelled text, and draft snapshots are not conversation turns and are not
persisted. Commit idempotency is deliberately limited to the live process and
session; the protocol does not claim crash-durable exactly-once delivery.
`stopped` is terminal for a live transcriber and requires a fresh
`dictation.start`. Paused, stopped, cancelled, and error sessions reject late
context, operation, and commit work; all capture-bearing states have a bounded
timeout.

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
