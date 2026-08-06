// Thin managed-backend wrapper for OpenClaw — delegates to openclaw.mjs gateway.
import { spawnAndProxy } from './lib/launcher.mjs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
const PORT = process.env.OPENCLAW_PORT || '18789'

spawnAndProxy(process.execPath, [
  resolve(ROOT, 'scripts/openclaw.mjs'),
  'gateway', 'run', '--port', PORT, '--bind', 'loopback',
  ...process.argv.slice(2),
]).then(code => process.exit(code))
