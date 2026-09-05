import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const clientSourceDirectories = [
  'tui/src',
  'web/src',
  'desktop/src',
  'mobile/src',
]
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const implementationTerms = /\b(?:tailscale|tailnet|tsnet|funnel)\b/i

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return sourceExtensions.has(extname(path)) ? [path] : []
  })
}

test('Clients depend only on generic Gateway URLs and never on the remote-access implementation', () => {
  const violations = clientSourceDirectories.flatMap(relativeDirectory => {
    const directory = join(root, relativeDirectory)
    return sourceFiles(directory).flatMap(path => {
      const match = readFileSync(path, 'utf8').match(implementationTerms)
      return match ? [`${path.slice(root.length + 1)}: ${match[0]}`] : []
    })
  })

  assert.deepEqual(violations, [])
})
