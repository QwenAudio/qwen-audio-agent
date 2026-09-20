import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

test('source Gateway launch commands use the public CLI and its lifecycle handling', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(scripts.start, 'node cli/bin/qwenaudio.mjs gateway')
  assert.equal(scripts.gateway, scripts.start)
  assert.equal(scripts.cli, 'npm run start --workspace @qwen-audio-agent/cli --')
  assert.equal(scripts.backend, undefined, 'backend must not mean starting the whole Gateway')
  assert.equal(existsSync(new URL('../scripts/start.mjs', import.meta.url)), false)
  // The service launches the child directly; it must not recursively spawn the CLI.
  const server = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'))
  assert.equal(server.scripts.start, 'node src/index.mjs')
})
