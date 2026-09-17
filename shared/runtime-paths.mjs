import { homedir } from 'node:os'
import { resolve } from 'node:path'

// Product configuration root and Gateway path policy. The root may contain
// client-owned subdirectories (e.g. tui/); Gateway owns only its own files.
// Configuration and durable user data are shared; each Gateway owns its state.
// Nothing here reads configuration, creates directories or migrates old files.
export function userConfigDirectory(env = process.env, homeDirectory = homedir()) {
  if (env.QWAUDIO_CONFIG_DIR) return resolve(env.QWAUDIO_CONFIG_DIR)
  return resolve(env.XDG_CONFIG_HOME || resolve(homeDirectory, '.config'), 'qwaudio')
}

export function defaultBackendWorkspace(dataDirectory, env = {}, baseDirectory = process.cwd()) {
  return env.QWAUDIO_WORKSPACE
    ? resolve(baseDirectory, env.QWAUDIO_WORKSPACE)
    : resolve(dataDirectory, 'workspace')
}

export function resolveRuntimePaths({
  env = process.env,
  homeDirectory = homedir(),
  baseDirectory = process.cwd(),
  defaultStateDirectory,
} = {}) {
  const configDirectory = userConfigDirectory(env, homeDirectory)
  const directory = (key, fallback) => env[key]
    ? resolve(baseDirectory, env[key])
    : resolve(configDirectory, fallback)
  const dataDirectory = directory('QWAUDIO_DATA_DIR', 'data')
  return {
    configDirectory,
    dataDirectory,
    stateDirectory: directory('QWAUDIO_STATE_DIR', defaultStateDirectory || 'state'),
    cacheDirectory: directory('QWAUDIO_CACHE_DIR', 'cache'),
    sharedWorkspace: defaultBackendWorkspace(dataDirectory, env, baseDirectory),
  }
}

// Propagate resolved absolute paths to child processes, including background
// services which cannot inherit the shell that originally configured them.
export function runtimePathEnvironment(paths) {
  return {
    QWAUDIO_CONFIG_DIR: paths.configDirectory,
    QWAUDIO_DATA_DIR: paths.dataDirectory,
    QWAUDIO_STATE_DIR: paths.stateDirectory,
    QWAUDIO_CACHE_DIR: paths.cacheDirectory,
    QWAUDIO_WORKSPACE: paths.sharedWorkspace,
  }
}
