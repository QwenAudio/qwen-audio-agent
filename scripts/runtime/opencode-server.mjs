// Thin managed-backend wrapper for OpenCode — delegates to opencode.mjs serve.
// Exists so managed-backend.mjs can launch a stable runtime entry.
import { spawnAndProxy } from './launcher.mjs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..', '..'))
const serveScript = resolve(ROOT, 'scripts/runtime/opencode.mjs')

spawnAndProxy(process.execPath, [serveScript, 'serve', ...process.argv.slice(2)])
  .then(code => process.exit(code))
