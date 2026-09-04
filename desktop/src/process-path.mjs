// Compatibility facade for desktop callers. Process discovery belongs to the
// shared runtime because CLI services, Gateway children and Electron must see
// the same user-installed commands.
export * from '../../shared/process-path.mjs'
