import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src',
)

function rendererDependencies(entry) {
  const pending = [entry]
  const visited = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)

    const source = readFileSync(file, 'utf8')
    const imports = source.matchAll(
      /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g,
    )
    for (const [, , specifier] of imports) {
      assert.equal(
        specifier.startsWith('node:'),
        false,
        `${file} imports Node-only module ${specifier}`,
      )
      if (!specifier.startsWith('.')) continue
      pending.push(resolve(dirname(file), specifier))
    }
  }

  return visited
}

test('settings renderer dependency graph stays browser-safe', () => {
  const dependencies = rendererDependencies(resolve(sourceDirectory, 'settings.js'))

  assert.ok(dependencies.size > 1)
})

test('desktop settings consumes Gateway invitations but does not issue them', () => {
  const html = readFileSync(resolve(sourceDirectory, 'settings.html'), 'utf8')
  const renderer = readFileSync(resolve(sourceDirectory, 'settings.js'), 'utf8')
  const preload = readFileSync(resolve(sourceDirectory, 'preload.cjs'), 'utf8')

  assert.match(html, /id="remote-gateway-invitation"/)
  assert.match(renderer, /connectRemoteGateway\(invitation\)/)
  assert.match(preload, /qwen-audio-agent:remote-gateway-connect/)
  assert.doesNotMatch(html, /invite-remote-client/)
  assert.doesNotMatch(preload, /remote-access-invite/)
})
