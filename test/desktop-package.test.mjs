import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import afterPack from '../scripts/desktop-after-pack.mjs'

test('desktop packaging uses the lockfile-pinned Electron instead of a second version', () => {
  const config = parse(readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(config.electronVersion, undefined)
  assert.equal(manifest.devDependencies.electron, lock.packages['node_modules/electron'].version)
  assert.equal(lock.packages.desktop.devDependencies.electron, manifest.devDependencies.electron)
  assert.equal(config.afterPack, 'scripts/desktop-after-pack.mjs')
  // extraResources implicitly excludes its source from ASAR. Do not move
  // shared application modules there; the afterPack hook makes a second copy.
  assert.ok(config.files.includes('shared/**/*'))
  assert.ok(config.extraResources.every(item => !item.from.startsWith('shared')))
})

test('afterPack copies the external module without moving its application source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qwa-after-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'shared'))
  const source = join(root, 'shared/runtime-paths.mjs')
  writeFileSync(source, 'export const fixture = true\n')
  const resources = join(root, 'app/Contents/Resources')
  await afterPack({ appOutDir: 'app', packager: {
    projectDir: root,
    getResourcesDir: () => resources,
  } })
  assert.equal(readFileSync(join(resources, 'runtime/shared/runtime-paths.mjs'), 'utf8'), readFileSync(source, 'utf8'))
})

test('release verifies both desktop artifacts before publishing npm', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  assert.ok(workflow.jobs.npm.needs.includes('macos'))
  assert.ok(workflow.jobs.npm.needs.includes('windows'))
  for (const platform of ['macos', 'windows']) {
    assert.ok(workflow.jobs[platform].steps.some(step => step.run?.includes('scripts/test/desktop-package-smoke.mjs')))
  }
})

test('macOS release imports the certificate separately and requires a signed build', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.macos.steps
  const signing = steps.find(step => step.id === 'signing')
  // These are different secrets. Partition access requires the keychain password,
  // whereas importing the encrypted P12 requires the certificate password.
  assert.match(signing.run, /create-keychain -p "\$KEYCHAIN_PASSWORD"/)
  assert.match(signing.run, /-P "\$CSC_KEY_PASSWORD"/)
  assert.match(signing.run, /set-key-partition-list[^]*-k "\$KEYCHAIN_PASSWORD"/)
  assert.match(signing.run, /CSC_KEYCHAIN=.*GITHUB_ENV/)
  assert.match(signing.run, /CSC_NAME=.*GITHUB_ENV/)
  assert.match(signing.run, /trap 'rm -f "\$CERTIFICATE_PATH"' EXIT/)
  const build = steps.find(step => step.run?.startsWith('npm run desktop:build --'))
  assert.equal(build.env.CSC_LINK, undefined)
  assert.equal(build.env.CSC_KEY_PASSWORD, undefined)
  assert.match(build.run, /--config.forceCodeSigning=true/)
  assert.ok(steps.indexOf(signing) < steps.indexOf(build))
  const cleanup = steps.find(step => step.run?.includes('delete-keychain'))
  assert.match(cleanup.if, /always\(\)/)
  assert.ok(steps.indexOf(cleanup) > steps.indexOf(build))
})
