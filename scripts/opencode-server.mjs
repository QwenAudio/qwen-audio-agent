// Thin managed-backend wrapper for OpenCode — delegates to opencode.mjs serve.
// Exists so managed-backend.mjs can use a flat scripts/${driver.managedScript}
// path without concatenating argv itself.
import { spawnAndProxy } from './lib/launcher.mjs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
const serveScript = resolve(ROOT, 'scripts/opencode.mjs')

spawnAndProxy(process.execPath, [serveScript, 'serve', ...process.argv.slice(2)])
  .then(code => process.exit(code))
