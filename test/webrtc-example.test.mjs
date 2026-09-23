import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { demoEnvironment } from '../examples/webrtc/start.mjs'
import { parsePackOutput } from '../scripts/verify-package.mjs'

const root = new URL('../', import.meta.url)
const nativePath = 'packages/webrtc'

test('demo enables WebRTC only in its own environment and selects matched Audio/Omni models', () => {
  const original = { DASHSCOPE_API_KEY: 'synthetic-key', QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', QWAUDIO_WEBRTC_ENABLED: '0' }
  const audio = demoEnvironment(original)
  assert.equal(audio.QWAUDIO_WEBRTC_ENABLED, '1')
  assert.equal(audio.QWEN_AUDIO_REALTIME_PROVIDER, 'dashscope')
  assert.equal(audio.QWEN_AUDIO_REALTIME_MODEL, 'qwen-audio-3.0-realtime-plus')
  assert.equal(audio.DASHSCOPE_API_KEY, 'synthetic-key')
  assert.equal(original.QWAUDIO_WEBRTC_ENABLED, '0')
  assert.equal(original.QWEN_AUDIO_REALTIME_PROVIDER, 'stepfun')
  assert.equal(demoEnvironment(original, ['--omni']).QWEN_AUDIO_REALTIME_MODEL, 'qwen3.5-omni-plus-realtime')
  assert.throws(() => demoEnvironment(original, ['--unknown']), /Usage/)
})

test('native dependencies are explicit installs, not default Gateway or example dependencies', async () => {
  for (const path of ['package.json', 'server/package.json', 'examples/webrtc/package.json']) {
    const manifest = JSON.parse(await readFile(new URL(path, root), 'utf8'))
    for (const group of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      assert.equal(manifest[group]?.['@roamhq/wrtc'], undefined, `${path}: ${group}`)
      assert.equal(manifest[group]?.sharp, undefined, `${path}: ${group}`)
      assert.equal(manifest[group]?.['qwen-audio-agent-webrtc'], undefined, `${path}: ${group}`)
    }
    assert.ok(!manifest.workspaces?.includes(nativePath))
  }
  const manifest = JSON.parse(await readFile(new URL(`${nativePath}/package.json`, root), 'utf8'))
  assert.equal(manifest.name, 'qwen-audio-agent-webrtc')
  assert.notEqual(manifest.private, true)
  assert.equal(manifest.qwaudioWebrtcApiVersion, 1)
  assert.ok(manifest.dependencies['@roamhq/wrtc'])
  assert.ok(manifest.dependencies.sharp)
})

test('npm pack keeps the usable example but excludes installed media, SDKs and private configuration', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'qwaudio-webrtc-pack-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  // npm walks files differently inside a workspace. A non-workspace fixture
  // misses the real failure even when nested .npmignore tests pass.
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'webrtc-pack-fixture', version: '1.0.0', files: manifest.files, workspaces: manifest.workspaces }))
  for (const workspace of manifest.workspaces) {
    await mkdir(join(fixture, workspace), { recursive: true })
    await writeFile(join(fixture, workspace, 'package.json'), JSON.stringify({ name: `fixture-${workspace}`, version: '1.0.0', private: true }))
  }
  const required = [
    'examples/webrtc/README.md', 'examples/webrtc/README_ZH.md',
    'examples/webrtc/package.json', 'examples/webrtc/start.mjs',
    'examples/webrtc/index.html', 'examples/webrtc/client.mjs',
    'examples/webrtc/styles.css',
    'examples/webrtc/.env.example',
    'shared/gateway/webrtc.mjs',
    'shared/gateway/webrtc-browser.mjs',
    'shared/gateway/webrtc-message.mjs',
  ]
  for (const path of [...required, '.npmignore', 'examples/webrtc/.npmignore', `${nativePath}/package.json`, `${nativePath}/index.cjs`]) {
    const target = join(fixture, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(new URL(path, root), target)
  }
  for (const path of [
    `${nativePath}/node_modules/@roamhq/wrtc/wrtc.node`,
    `${nativePath}/node_modules/sharp/libvips.dylib`,
    `${nativePath}/.env`, `${nativePath}/install.log`,
    'examples/webrtc/node_modules/playwright/index.js',
    'examples/webrtc/.env', 'examples/webrtc/.env.local',
    'examples/webrtc/debug.log',
    'examples/ai-passport/device-relay.test.mjs',
    'examples/ai-passport/test/fixture.json',
    'examples/customer-service/assets/demo.mp4',
    'examples/voicemem/server.py',
    'examples/lightrag/.env',
    'examples/digital-human/node_modules/sdk/index.js',
  ]) {
    const target = join(fixture, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'synthetic fixture; must not ship')
  }
  const npm = process.env.npm_execpath
  const result = spawnSync(npm ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    ...(npm ? [npm] : []), 'pack', '--dry-run', '--json', '--ignore-scripts',
  ], {
    cwd: fixture, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, npm_config_cache: join(fixture, 'npm-cache'), npm_config_global: 'false' },
    shell: !npm && process.platform === 'win32',
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const [packed] = parsePackOutput(result.stdout)
  const files = packed.files.map(file => file.path)
  for (const path of required) assert.ok(files.includes(path), `missing ${path}`)
  assert.deepEqual(files.filter(path => path.startsWith(`${nativePath}/`)), [])
  assert.deepEqual(files.filter(path => path.includes('/node_modules/')), [])
  assert.deepEqual(files.filter(path => path.endsWith('.test.mjs') || path.split('/').includes('test')), [])
  assert.deepEqual(files.filter(path => /^examples\/(customer-service|voicemem|lightrag|digital-human)\//.test(path)), [])
  assert.deepEqual(files.filter(path => /\/(?:\.env(?:\..+)?|[^/]+\.log)$/.test(path) && !path.endsWith('/.env.example')), [])
  assert.ok(packed.unpackedSize < 250000, `unexpected demo size ${packed.unpackedSize}`)
})
