// CommonJS entry for an Electron host.
//
// This package is ESM. An Electron main process is commonly CommonJS, and a
// host had to hand-write ESM bridge files to reach any of our contracts, once
// per host, including the build-step workarounds that come with it.
//
// So the bridge ships here instead. This file is CommonJS, loads the ESM
// contracts through dynamic import (which CommonJS has always had), and caches
// the result so every caller shares one module instance.
//
//   const audioAgent = require('qwen-audio-agent/electron')
//   const api = await audioAgent.load()
//   if (!api.createSettingsStore({ configDir, clientDir }).ready()) { … }
//   const gateway = api.createGatewayProcess({ configDir, wakeWord: false })
//   await gateway.start()

const { pathToFileURL } = require('node:url')

// Resolved relative to this file, so the paths survive being installed
// anywhere.
const MODULES = {
  gatewayProtocol: '../server/src/core/gateway-protocol.mjs',
  gatewaySetup: './gateway/setup.mjs',
  gatewayProcess: './gateway/process.mjs',
  gatewayLease: './gateway/lease.mjs',
  runtimePaths: './runtime-paths.mjs',
  realtimeEvents: './protocol/realtime-events.mjs',
  settings: '../desktop/src/settings-store.mjs',
  skinStore: '../desktop/src/skin-store.mjs',
  presence: '../desktop/src/desktop-presence.mjs',
  orbShell: '../desktop/src/orb-shell.mjs',
  orbWindow: '../desktop/src/orb-window.mjs',
  orbPlacement: '../desktop/src/orb-placement.mjs',
  orbUrl: '../desktop/src/orb-url.mjs',
}

// The renderer bridge the orb page expects. A CommonJS host can resolve it
// directly, which is what a BrowserWindow's preload option needs.
const PRELOAD_PATH = require.resolve('../desktop/src/preload.cjs')

let loaded = null

function importModule(relativePath) {
  // require.resolve does the path math without loading, and pathToFileURL
  // keeps it correct on Windows, where a naive file:// concatenation is not a
  // URL.
  return import(pathToFileURL(require.resolve(relativePath)).href)
}

/**
 * Loads every contract module once and returns them as one namespace.
 *
 * @returns {Promise<object>} The union of the documented ESM entry points,
 *   plus `modules` (the raw namespaces) and PRELOAD_PATH.
 */
async function load() {
  loaded ||= (async () => {
    const entries = await Promise.all(
      Object.entries(MODULES).map(async ([name, path]) => [
        name,
        await importModule(path),
      ]),
    )
    const modules = Object.fromEntries(entries)
    return Object.freeze({
      // Namespaces, for anything added later that this facade has not named.
      modules,
      PRELOAD_PATH,

      // Contract surface and the setup gate.
      GATEWAY_PROTOCOL_VERSION: modules.gatewayProtocol.GATEWAY_PROTOCOL_VERSION,
      GATEWAY_CAPABILITIES: modules.gatewayProtocol.GATEWAY_CAPABILITIES,
      gatewaySetupStatus: modules.gatewaySetup.gatewaySetupStatus,

      // Hosted Gateway process.
      GatewayProcess: modules.gatewayProcess.GatewayProcess,
      createGatewayProcess: modules.gatewayProcess.createGatewayProcess,
      GATEWAY_READY_MESSAGE: modules.gatewayProcess.GATEWAY_READY_MESSAGE,
      DEFAULT_GATEWAY_ENTRY: modules.gatewayProcess.DEFAULT_GATEWAY_ENTRY,
      validateGatewayOrigin: modules.gatewayProcess.validateGatewayOrigin,
      portInUse: modules.gatewayProcess.portInUse,

      // Locating a running instance through its lease.
      readGatewayLease: modules.gatewayLease.readGatewayLease,
      findRunningGateway: modules.gatewayLease.findRunningGateway,

      // Realtime event names.
      GatewayClientEvent: modules.realtimeEvents.GatewayClientEvent,
      GatewayServerEvent: modules.realtimeEvents.GatewayServerEvent,
      GatewayTaskEvent: modules.realtimeEvents.GatewayTaskEvent,

      // Component-owned configuration.
      createSettingsStore: modules.settings.createSettingsStore,
      resolveRuntimePaths: modules.runtimePaths.resolveRuntimePaths,

      // Orb skins.
      importSkin: modules.skinStore.importSkin,
      listSkins: modules.skinStore.listSkins,
      removeSkin: modules.skinStore.removeSkin,
      effectiveOrbSkin: modules.skinStore.effectiveOrbSkin,
      skinsDirectory: modules.skinStore.skinsDirectory,

      // The orb form.
      DesktopPresence: modules.presence.DesktopPresence,
      bindOrbShell: modules.orbShell.bindOrbShell,
      configureOrbWindow: modules.orbShell.configureOrbWindow,
      ORB_CHANNELS: modules.orbShell.ORB_CHANNELS,
      createOrbWindow: modules.orbWindow.createOrbWindow,
      orbWindowOptions: modules.orbWindow.orbWindowOptions,
      ORB_PRELOAD_PATH: modules.orbWindow.ORB_PRELOAD_PATH,
      createOrbPlacement: modules.orbPlacement.createOrbPlacement,
      desktopOrbUrl: modules.orbUrl.desktopOrbUrl,
    })
  })()
  return loaded
}

module.exports = { load, PRELOAD_PATH }
