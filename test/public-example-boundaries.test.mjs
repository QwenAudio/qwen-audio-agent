import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const examples = [
  '../examples/smart-cockpit/bench/runner/run-voice.mjs',
]

test('public examples depend only on exported framework entry points', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  for (const path of examples) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    const imports = [...source.matchAll(
      /from ['"]qwen-audio-agent\/([^'"]+)['"]/g,
    )]
    assert.ok(imports.length, `${path} does not use a public framework entry`)
    for (const [, subpath] of imports) {
      assert.ok(
        manifest.exports[`./${subpath}`],
        `${path} imports an unexported framework entry: ${subpath}`,
      )
    }
    assert.doesNotMatch(
      source,
      /from ['"](?:\.\.\/)+(?:server\/src|shared)\//,
      `${path} imports a private framework module`,
    )
  }
})
