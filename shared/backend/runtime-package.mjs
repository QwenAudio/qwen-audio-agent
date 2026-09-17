import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { backendDefinition } from './catalog.mjs'
import { resolveRuntimePaths } from '../runtime-paths.mjs'

// Optional backend libraries live outside the framework installation. Inspection
// only reads manifests/resolves paths: it never imports code or installs packages.
export function backendRuntimeDirectory(id, env = process.env) {
  if (!backendDefinition(id)) throw new Error(`Unknown backend: ${id}`)
  return resolve(resolveRuntimePaths({ env }).dataDirectory, 'backends', id, 'runtime')
}

export function inspectBackendRuntimePackage(id, {
  env = process.env,
  directory = backendRuntimeDirectory(id, env),
} = {}) {
  const spec = backendDefinition(id)?.setup?.runtimePackage
  if (!spec) throw new Error(`Backend ${id} has no runtime package`)
  const packageDirectory = resolve(directory, 'node_modules', spec.name)
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    if (manifest.name !== spec.name || manifest.version !== spec.version) {
      throw new Error('Package version mismatch')
    }
    const require = createRequire(resolve(directory, 'loader.cjs'))
    return { ready: true, source: 'installed', path: require.resolve(packageDirectory) }
  } catch {
    return {
      ready: false,
      source: 'missing',
      issue: `缺少或版本不匹配的 ${spec.name}@${spec.version}；请运行 qwenaudio install ${id}`,
    }
  }
}
