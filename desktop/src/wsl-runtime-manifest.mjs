import { readFileSync as nodeReadFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../shared/desktop-host-protocol.mjs'

const PACKAGE_NAME = 'qwen-audio-agent'

function invalidManifest() {
  return new Error('Invalid bundled WSL runtime manifest')
}

export function readBundledWslRuntimeManifest({
  directory,
  desktopVersion,
  readFileSync = nodeReadFileSync,
} = {}) {
  try {
    const path = String(directory || '').includes('\\') ? win32 : posix
    const manifest = JSON.parse(
      readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
    )
    const expectedTarball = `${PACKAGE_NAME}-${desktopVersion}.tgz`
    if (
      manifest?.schemaVersion !== 1
      || manifest.packageName !== PACKAGE_NAME
      || manifest.packageVersion !== desktopVersion
      || manifest.desktopVersion !== desktopVersion
      || manifest.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION
      || !/^[a-f\d]{64}$/.test(String(manifest.sha256 || ''))
      || manifest.tarball !== expectedTarball
      || path.basename(manifest.tarball) !== manifest.tarball
      || manifest.tarball.includes('/')
      || manifest.tarball.includes('\\')
    ) throw invalidManifest()
    return {
      packageVersion: manifest.packageVersion,
      protocolVersion: manifest.protocolVersion,
      runtimeSha256: manifest.sha256,
      bundledTarballPath: path.join(directory, manifest.tarball),
    }
  } catch {
    throw invalidManifest()
  }
}
