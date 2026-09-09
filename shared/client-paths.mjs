import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { userConfigDirectory } from './runtime-paths.mjs'

// TUI state belongs to the client, under the product's configuration root.
// Gateway data/state/cache overrides must never relocate client files.
export function tuiClientDirectory(env = process.env, homeDirectory = homedir()) {
  return env.QWAUDIO_TUI_DIR
    ? resolve(env.QWAUDIO_TUI_DIR)
    : resolve(userConfigDirectory(env, homeDirectory), 'tui')
}
