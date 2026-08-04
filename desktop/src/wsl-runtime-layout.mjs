import { posix } from 'node:path'
import { buildWslLoginCommand } from './wsl-discovery.mjs'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_PATTERN = /^[a-f\d]{64}$/i
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const PRIVATE_SUFFIX = '.local/share/qwaudio/windows-client'

function parseSemanticVersion(value, label = 'version') {
  const text = String(value ?? '')
  const match = text.match(SEMVER_PATTERN)
  if (!match) throw new Error(`Invalid ${label}: ${text}`)
  return {
    text,
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (leftValue === undefined) return -1
    if (rightValue === undefined) return 1
    if (leftValue === rightValue) continue
    const leftNumeric = /^\d+$/.test(leftValue)
    const rightNumeric = /^\d+$/.test(rightValue)
    if (leftNumeric && rightNumeric) return Number(leftValue) < Number(rightValue) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftValue < rightValue ? -1 : 1
  }
  return 0
}

export function compareSemanticVersions(leftValue, rightValue) {
  const left = parseSemanticVersion(leftValue)
  const right = parseSemanticVersion(rightValue)
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] === right.numbers[index]) continue
    return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function assertAbsoluteWslPath(value, label) {
  const text = String(value ?? '')
  if (
    !text.startsWith('/')
    || text === '/'
    || CONTROL_CHARACTERS.test(text)
    || text.includes('\\')
    || posix.normalize(text) !== text
  ) {
    throw new Error(`${label} must be an absolute WSL path`)
  }
  return text
}

function assertDescendant(root, candidate, label) {
  const relative = posix.relative(root, candidate)
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error(`${label} must stay below the private qwaudio root`)
  }
  return candidate
}

function assertDesktopVersion(value) {
  try {
    return parseSemanticVersion(value, 'desktop version').text
  } catch {
    throw new Error(`Invalid desktop version: ${String(value ?? '')}`)
  }
}

export function createWslRuntimeLayout({
  homeDirectory,
  desktopVersion,
} = {}) {
  const home = assertAbsoluteWslPath(homeDirectory, 'Expected absolute WSL home')
  const version = assertDesktopVersion(desktopVersion)
  const privateRoot = posix.join(home, PRIVATE_SUFFIX)
  const runtimeRoot = assertDescendant(
    privateRoot,
    posix.join(privateRoot, 'runtime'),
    'Runtime root',
  )
  const versionDirectory = assertDescendant(
    runtimeRoot,
    posix.join(runtimeRoot, version),
    'Runtime version directory',
  )
  return {
    homeDirectory: home,
    privateRoot,
    runtimeRoot,
    versionDirectory,
    executablePath: assertDescendant(
      versionDirectory,
      posix.join(versionDirectory, 'node_modules/.bin/qwenaudio'),
      'Runtime executable',
    ),
    versionMarkerPath: assertDescendant(
      versionDirectory,
      posix.join(versionDirectory, 'runtime.json'),
      'Runtime marker',
    ),
    currentMarkerPath: assertDescendant(
      privateRoot,
      posix.join(privateRoot, 'current.json'),
      'Current marker',
    ),
  }
}

function assertIsoTimestamp(value, label) {
  const text = String(value ?? '')
  let normalized
  try {
    normalized = new Date(text).toISOString()
  } catch {
    throw new Error(`${label} must be an ISO timestamp`)
  }
  if (normalized !== text) throw new Error(`${label} must be an ISO timestamp`)
  return text
}

export function createWslRuntimeMarker({
  desktopVersion,
  packageVersion,
  protocolVersion,
  sha256,
  installedAt,
} = {}) {
  const protocol = Number(protocolVersion)
  if (!Number.isSafeInteger(protocol) || protocol < 1) {
    throw new Error('Protocol version must be a positive integer')
  }
  const digest = String(sha256 ?? '')
  if (!SHA256_PATTERN.test(digest)) throw new Error('Invalid SHA-256 digest')
  return {
    desktopVersion: assertDesktopVersion(desktopVersion),
    packageVersion: parseSemanticVersion(
      packageVersion,
      'package version',
    ).text,
    protocolVersion: protocol,
    sha256: digest.toLowerCase(),
    installedAt: assertIsoTimestamp(installedAt, 'Installation time'),
  }
}

export function createCurrentRuntimeMarker({
  marker,
  bridgeReady,
  gatewayHealthy,
  promotedAt = new Date().toISOString(),
} = {}) {
  if (!bridgeReady) throw new Error('Bridge handshake must succeed before promotion')
  if (!gatewayHealthy) {
    throw new Error('Gateway health check must succeed before promotion')
  }
  const runtime = createWslRuntimeMarker(marker)
  return {
    desktopVersion: runtime.desktopVersion,
    packageVersion: runtime.packageVersion,
    protocolVersion: runtime.protocolVersion,
    sha256: runtime.sha256,
    promotedAt: assertIsoTimestamp(promotedAt, 'Promotion time'),
  }
}

const COMPATIBILITY_FIELDS = [
  'desktopVersion',
  'packageVersion',
  'protocolVersion',
  'sha256',
]

function runtimeVersion(value, { stripNodePrefix = false } = {}) {
  let text = String(value ?? '').trim()
  if (stripNodePrefix && text.startsWith('v')) text = text.slice(1)
  try {
    return parseSemanticVersion(text, 'runtime version')
  } catch {
    return null
  }
}

function supportedNodeVersion(value) {
  const version = runtimeVersion(value, { stripNodePrefix: true })
  if (!version || version.prerelease.length) return false
  const [major, minor, patch] = version.numbers
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2)
  if (major === 24) return minor >= 15
  return major >= 26
}

function supportedNpmVersion(value) {
  const version = runtimeVersion(value)
  return Boolean(
    version
    && !version.prerelease.length
    && version.numbers[0] >= 10,
  )
}

export function runtimeSetupState({
  nodeVersion,
  npmVersion,
  marker,
  expectedMarker,
  executableExists,
} = {}) {
  const missing = [
    ...(!supportedNodeVersion(nodeVersion) ? ['node'] : []),
    ...(!supportedNpmVersion(npmVersion) ? ['npm'] : []),
  ]
  if (missing.length) return { state: 'node-required', missing }
  const expected = createWslRuntimeMarker(expectedMarker)
  let actual
  try {
    actual = createWslRuntimeMarker(marker)
  } catch {
    return { state: 'runtime-required', reason: 'missing-or-invalid-marker' }
  }
  if (!executableExists) {
    return { state: 'runtime-required', reason: 'missing-executable' }
  }
  const mismatch = COMPATIBILITY_FIELDS.find(field => (
    actual[field] !== expected[field]
  ))
  if (mismatch) {
    return { state: 'runtime-required', reason: `${mismatch}-mismatch` }
  }
  return { state: 'ready' }
}

function shellEscape(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@%+=,~+-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\"'\"'")}'`
}

export function createWslRuntimeInstallPlan({
  distribution,
  layout,
  bundledTarballWslPath,
} = {}) {
  const tarball = assertAbsoluteWslPath(
    bundledTarballWslPath,
    'Bundled tarball',
  )
  const home = assertAbsoluteWslPath(
    layout?.homeDirectory,
    'Layout home',
  )
  const suppliedVersionDirectory = assertAbsoluteWslPath(
    layout?.versionDirectory,
    'Runtime version directory',
  )
  const expectedLayout = createWslRuntimeLayout({
    homeDirectory: home,
    desktopVersion: posix.basename(suppliedVersionDirectory),
  })
  if (
    layout?.privateRoot !== expectedLayout.privateRoot
    || suppliedVersionDirectory !== expectedLayout.versionDirectory
  ) {
    throw new Error('Runtime layout must use the fixed private qwaudio root')
  }
  const versionDirectory = expectedLayout.versionDirectory
  const args = [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--prefix',
    versionDirectory,
    tarball,
  ]
  const displayPrefix = `~${versionDirectory.slice(home.length)}`
  const displayArgs = [
    'npm',
    ...args.slice(0, 4),
    displayPrefix,
    tarball,
  ]
  return {
    command: buildWslLoginCommand({
      distribution,
      executable: 'npm',
      args,
    }),
    displayCommand: displayArgs.map(shellEscape).join(' '),
  }
}

export function resolveWslRuntimeEntry({
  appIsPackaged,
  env = process.env,
  packagedEntry,
} = {}) {
  const packaged = assertAbsoluteWslPath(
    packagedEntry,
    'Packaged runtime entry',
  )
  if (appIsPackaged) return packaged
  const override = env.QWEN_AUDIO_DESKTOP_WSL_RUNTIME_ENTRY
  if (override === undefined || override === '') return packaged
  return assertAbsoluteWslPath(override, 'Development runtime entry')
}
