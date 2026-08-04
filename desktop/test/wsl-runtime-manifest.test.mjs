import assert from 'node:assert/strict'
import test from 'node:test'
import { readBundledWslRuntimeManifest } from '../src/wsl-runtime-manifest.mjs'

const VALID = {
  schemaVersion: 1,
  packageName: 'qwen-audio-agent',
  packageVersion: '1.2.0',
  desktopVersion: '1.2.0',
  protocolVersion: 1,
  sha256: 'ab'.repeat(32),
  tarball: 'qwen-audio-agent-1.2.0.tgz',
}

function readManifest(value) {
  return readBundledWslRuntimeManifest({
    directory: 'C:\\Program Files\\Qwen Audio Agent\\resources\\wsl-runtime',
    desktopVersion: '1.2.0',
    readFileSync: () => JSON.stringify(value),
  })
}

test('returns only validated runtime metadata and the exact bundled tarball path', () => {
  assert.deepEqual(readManifest(VALID), {
    packageVersion: '1.2.0',
    protocolVersion: 1,
    runtimeSha256: 'ab'.repeat(32),
    bundledTarballPath: 'C:\\Program Files\\Qwen Audio Agent\\resources\\wsl-runtime\\qwen-audio-agent-1.2.0.tgz',
  })
})

test('rejects version, protocol, hash, package, and filename mismatches', () => {
  const invalid = [
    { packageName: 'other' },
    { packageVersion: '1.2.1' },
    { desktopVersion: '1.2.1' },
    { protocolVersion: 2 },
    { sha256: 'not-a-hash' },
    { tarball: '../qwen-audio-agent-1.2.0.tgz' },
    { tarball: 'other.tgz' },
  ]
  for (const override of invalid) {
    assert.throws(() => readManifest({ ...VALID, ...override }), /manifest/i)
  }
})

test('rejects malformed manifest JSON without reflecting its content', () => {
  assert.throws(() => readBundledWslRuntimeManifest({
    directory: 'C:\\runtime',
    desktopVersion: '1.2.0',
    readFileSync: () => '{token=super-secret',
  }), error => (
    /manifest/i.test(error.message)
    && !error.message.includes('super-secret')
  ))
})
