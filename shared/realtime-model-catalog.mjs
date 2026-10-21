// Compatibility facade. API presets, built-in data and snapshot parsing live
// separately so every runtime can consume the same browser-safe model catalog.
export * from './realtime-models/api-profiles.mjs'
export * from './realtime-models/builtins.mjs'
export * from './realtime-models/registry.mjs'
