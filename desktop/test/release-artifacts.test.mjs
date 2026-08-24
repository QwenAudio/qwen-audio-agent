import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('builds and uploads both install and automatic-update macOS artifacts', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

  assert.match(builder, /target:\s*\n\s*- dmg\s*\n\s*- zip/)
  assert.match(manifest.scripts['desktop:build'], /--mac dmg zip/)
  assert.match(workflow, /dist\/desktop\/\*\.dmg/)
  assert.match(workflow, /dist\/desktop\/\*\.zip/)
})

test('macOS packages version-matched native input artifacts inside Desktop', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

  assert.match(
    builder,
    /mac:[\s\S]*extraResources:[\s\S]*dist\/native-input\/QwenInputBridge/,
  )
  assert.match(
    builder,
    /mac:[\s\S]*dist\/native-input\/Qwen Input\.app/,
  )
  assert.match(
    manifest.scripts['desktop:build'],
    /native-input:build:release[\s\S]*electron-builder/,
  )
  assert.match(
    manifest.scripts['desktop:build:local'],
    /native-input:build[\s\S]*electron-builder/,
  )
})
