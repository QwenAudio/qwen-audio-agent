import { resolve } from 'node:path'

// Electron selects the platform-specific application directory. These paths
// are client-owned and must not follow QWAUDIO_CONFIG/DATA/STATE/CACHE_DIR.
export function desktopClientPaths(userDataDirectory) {
  if (!userDataDirectory) throw new TypeError('desktop user data directory is required')
  const directory = resolve(userDataDirectory)
  return {
    directory,
    skinsDirectory: resolve(directory, 'pets'),
    wakeWordModelDirectory: resolve(directory, 'cache/models/wake-word'),
    pathCacheFile: resolve(directory, 'cache/login-shell-path.json'),
    logDirectory: resolve(directory, 'logs'),
    credentialsPath: resolve(directory, 'gateway-credentials.json'),
    connectionsPath: resolve(directory, 'gateway-connections.json'),
  }
}
