// The initial orb page URL for a given Gateway origin. Query parameters seed
// client-owned presentation and presence preferences on first load; subsequent
// desktop setting changes travel over the Electron preload bridge so applying
// them never replaces the Gateway Client connection.
export { desktopOrbUrl } from './security.mjs'
