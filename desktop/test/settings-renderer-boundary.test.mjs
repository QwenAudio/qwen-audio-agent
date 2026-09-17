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
      assert.equal(
        specifier.startsWith('.'),
        true,
        `${file} imports ${specifier}, which the unbundled renderer cannot resolve`,
      )
      pending.push(resolve(dirname(file), specifier))
    }
  }

  return visited
}

test('settings renderer dependency graph stays browser-safe', () => {
  const dependencies = rendererDependencies(resolve(sourceDirectory, 'settings.js'))

  assert.ok(dependencies.size > 1)
})

test('desktop settings consumes Gateway pairing codes but does not issue them', () => {
  const html = readFileSync(resolve(sourceDirectory, 'settings.html'), 'utf8')
  const renderer = readFileSync(resolve(sourceDirectory, 'settings.js'), 'utf8')
  const preload = readFileSync(resolve(sourceDirectory, 'preload.cjs'), 'utf8')

  assert.match(html, /id="gateway-url"[^>]+placeholder="输入 Gateway 地址或连接链接"/)
  assert.doesNotMatch(html, /id="gateway-pairing-code"|id="connect-remote-gateway"/)
  assert.match(renderer, /saveSettings\(formSettings\(\)\)/)
  assert.doesNotMatch(preload, /remote-gateway-connect/)
  const main = readFileSync(resolve(sourceDirectory, 'main.mjs'), 'utf8')
  assert.match(main, /return applyDesktopSettings\(settings\)/)
  assert.match(main, /async function applyGatewayPairingCode[\s\S]*await applyDesktopSettings/)
  assert.match(main, /\(gatewayChanged \|\| credentialChanged\)/)
  assert.doesNotMatch(html, /create-gateway-pairing-code/)
  assert.doesNotMatch(preload, /pairing-tickets/)
})
