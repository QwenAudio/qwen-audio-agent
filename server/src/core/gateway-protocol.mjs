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
// 2.0.0 succeeds the 1.x line of the feat/embedded-gateway-host-contract
// fork (last 1.7.0). The major bump is semantic, not cosmetic: capabilities
// that line advertised (gateway.embedded-lifecycle, gateway.self-terminate,
// desktop.settings-window, …) are not part of this contract, and a removed
// capability is a breaking change. Hosts migrating from the fork must branch
// on the capability list below, never on the version number.
import { DICTATION_CAPABILITIES } from '../../../shared/dictation-protocol.mjs'

export const GATEWAY_PROTOCOL_VERSION = '2.1.0'

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
  ...DICTATION_CAPABILITIES,
])

export function runtimeGatewayCapabilities({ dictationEnabled = false } = {}) {
  return Object.freeze(GATEWAY_CAPABILITIES.filter(capability => (
    dictationEnabled || !DICTATION_CAPABILITIES.includes(capability)
  )))
}
