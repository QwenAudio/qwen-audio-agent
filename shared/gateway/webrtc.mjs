import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const requireGateway = createRequire(new URL('../../package.json', import.meta.url))
const developmentManifest = fileURLToPath(new URL('../../packages/webrtc/package.json', import.meta.url))
const extensionName = 'qwen-audio-agent-webrtc'
const apiVersion = 1
const installHint = 'Install qwen-audio-agent-webrtc alongside qwen-audio-agent: npm install -g qwen-audio-agent-webrtc. Source checkout: npm run example:webrtc:install.'

function extensionError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code })
}

// Resolve relative to the framework, never the caller's working directory.
// Neither the extension entry point nor native addons execute in this preflight.
export function requireWebRtcDependencies({
  resolvePackage = name => requireGateway.resolve(name),
  sourceManifest = developmentManifest,
} = {}) {
  let manifestPath
  try {
    manifestPath = resolvePackage(`${extensionName}/package.json`)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      throw extensionError('webrtc_extension_invalid', `Cannot resolve ${extensionName}. ${installHint}`, error)
    }
    if (!sourceManifest || !existsSync(sourceManifest)) {
      throw extensionError('webrtc_dependencies_missing', installHint, error)
    }
    manifestPath = sourceManifest
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw extensionError('webrtc_extension_invalid', `Cannot read ${extensionName}/package.json. ${installHint}`, error)
  }
  if (manifest?.name !== extensionName || manifest.qwaudioWebrtcApiVersion !== apiVersion) {
    throw extensionError('webrtc_extension_incompatible', `Incompatible ${extensionName}: Gateway requires extension API ${apiVersion}. Update the Gateway and extension together.`)
  }

  const requireExtension = createRequire(manifestPath)
  try {
    const entryPath = requireExtension.resolve(extensionName)
    for (const dependency of Object.keys(manifest.dependencies || {})) requireExtension.resolve(dependency)
    return { entryPath, apiVersion, version: manifest.version }
  } catch (error) {
    throw extensionError('webrtc_dependencies_missing', installHint, error)
  }
}
