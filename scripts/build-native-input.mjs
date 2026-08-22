#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { arch as currentArchitecture } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = resolve(root, 'desktop/native')
const project = resolve(nativeRoot, 'QwenInput.xcodeproj')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = {
    configuration: 'Debug',
    architecture: 'current',
    output: resolve(root, 'dist/native-input'),
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value) fail(`Missing value for ${name || 'argument'}`)
    if (name === '--configuration') options.configuration = value
    else if (name === '--arch') options.architecture = value
    else if (name === '--output') options.output = isAbsolute(value)
      ? resolve(value)
      : resolve(root, value)
    else fail(`Unknown argument: ${name}`)
  }
  if (!['Debug', 'Release'].includes(options.configuration)) {
    fail('Configuration must be Debug or Release')
  }
  if (!['current', 'universal'].includes(options.architecture)) {
    fail('Architecture must be current or universal')
  }
  return options
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function generateProject() {
  const probe = spawnSync('xcodegen', ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) {
    run('xcodegen', [
      'generate',
      '--spec', resolve(nativeRoot, 'project.yml'),
      '--project', nativeRoot,
      '--quiet',
    ])
  } else if (!existsSync(project)) {
    fail('xcodegen is unavailable and the generated Xcode project is missing')
  }
}

function buildScheme(scheme, options, derivedData, architectures) {
  run('xcodebuild', [
    '-project', project,
    '-scheme', scheme,
    '-configuration', options.configuration,
    '-derivedDataPath', derivedData,
    `ARCHS=${architectures}`,
    `ONLY_ACTIVE_ARCH=${options.architecture === 'current' ? 'YES' : 'NO'}`,
    'CODE_SIGN_STYLE=Manual',
    'CODE_SIGN_IDENTITY=-',
    'DEVELOPMENT_TEAM=',
    'build',
  ])
}

const options = parseArgs(process.argv.slice(2))
const architectures = options.architecture === 'universal'
  ? 'arm64 x86_64'
  : currentArchitecture() === 'arm64' ? 'arm64' : 'x86_64'
const derivedData = resolve(options.output, '.derived')
const products = resolve(
  derivedData,
  'Build/Products',
  options.configuration,
)

mkdirSync(options.output, { recursive: true })
generateProject()
buildScheme('QwenInputBridge', options, derivedData, architectures)
buildScheme('QwenInput', options, derivedData, architectures)

const artifacts = [
  ['QwenInputBridge', 'QwenInputBridge'],
  ['Qwen Input.app', 'Qwen Input.app'],
]
for (const [sourceName, destinationName] of artifacts) {
  const source = resolve(products, sourceName)
  const destination = resolve(options.output, destinationName)
  if (!existsSync(source)) fail(`Missing build product: ${source}`)
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
}

run('codesign', ['--force', '--sign', '-', resolve(options.output, 'QwenInputBridge')])
run('codesign', [
  '--force', '--deep', '--sign', '-', resolve(options.output, 'Qwen Input.app'),
])

