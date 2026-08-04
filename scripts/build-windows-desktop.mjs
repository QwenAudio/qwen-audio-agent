#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateWindowsReleaseEnvironment } from './check-windows-release-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNING_ENVIRONMENT_KEYS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_SUBJECT_NAME',
]
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function shouldStageWindowsOutput({
  platform = process.platform,
  rootDirectory = root,
  force = false,
} = {}) {
  const value = String(rootDirectory || '')
  return platform === 'win32'
    && (force || /^\\\\/.test(value) || /^\/\/[^/]/.test(value))
}

function nativeWindowsOutputDirectory(value) {
  const directory = String(value || '')
  if (
    !/^[A-Za-z]:[\\/]/.test(directory)
    || directory !== directory.trim()
    || CONTROL_CHARACTERS.test(directory)
  ) throw new Error('Windows builder output must use an absolute local drive path')
  return directory
}

export function publishWindowsDesktopOutput({
  staging,
  destination,
  fileSystem = {
    cpSync,
    copyFileSync,
    mkdirSync,
    readdirSync,
    rmSync,
  },
} = {}) {
  if (!staging || !destination || staging === destination) {
    throw new Error('Windows staging and publish directories must be distinct')
  }
  const entries = fileSystem.readdirSync(staging, { withFileTypes: true })
  if (!entries.length) throw new Error('Windows staging output is empty')
  fileSystem.mkdirSync(destination, { recursive: true })
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error('Windows staging output contains an unsupported entry')
    }
    const source = join(staging, entry.name)
    const target = join(destination, entry.name)
    fileSystem.rmSync(target, { recursive: true, force: true })
    if (entry.isDirectory()) {
      fileSystem.cpSync(source, target, { recursive: true, force: true })
    } else {
      fileSystem.copyFileSync(source, target)
    }
  }
}

function structuredText(value, label) {
  const text = String(value || '')
  if (!text || text !== text.trim() || CONTROL_CHARACTERS.test(text)) {
    throw new Error(`${label} is invalid`)
  }
  return text
}

function absoluteWslProjectDirectory(value) {
  const directory = structuredText(value, 'WSL project directory')
  if (
    !directory.startsWith('/')
    || directory === '/'
    || directory.includes('\\')
    || posix.normalize(directory) !== directory
  ) throw new Error('WSL project directory must be an absolute POSIX path')
  return directory
}

function stagingEntryName(value) {
  const name = structuredText(value, 'Windows staging entry')
  if (name === '.' || name === '..' || posix.basename(name) !== name) {
    throw new Error('Windows staging entry name is invalid')
  }
  return name
}

function runWslPublishCommand({ distribution, args, spawnImpl }) {
  const result = spawnImpl('wsl.exe', [
    '--distribution',
    distribution,
    '--exec',
    ...args,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  })
  if (result?.error || result?.status !== 0) {
    throw new Error('Could not publish Windows desktop output through WSL')
  }
  return String(result.stdout || '')
}

export function publishWindowsDesktopOutputThroughWsl({
  staging,
  distribution,
  projectDirectory,
  spawnImpl = spawnSync,
  fileSystem = { readdirSync },
} = {}) {
  const selectedDistribution = structuredText(
    distribution,
    'WSL distribution',
  )
  const project = absoluteWslProjectDirectory(projectDirectory)
  const entries = fileSystem.readdirSync(staging, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  if (!entries.length) throw new Error('Windows staging output is empty')
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error('Windows staging output contains an unsupported entry')
    }
    stagingEntryName(entry.name)
  }
  const sourceRoot = runWslPublishCommand({
    distribution: selectedDistribution,
    args: ['wslpath', '-a', '-u', structuredText(staging, 'Staging path')],
    spawnImpl,
  }).trim()
  if (
    !sourceRoot.startsWith('/')
    || sourceRoot === '/'
    || sourceRoot.includes('\\')
    || CONTROL_CHARACTERS.test(sourceRoot)
    || posix.normalize(sourceRoot) !== sourceRoot
  ) throw new Error('wslpath returned an invalid staging path')

  const destination = posix.join(project, 'dist/desktop')
  runWslPublishCommand({
    distribution: selectedDistribution,
    args: ['mkdir', '--parents', '--mode=755', destination],
    spawnImpl,
  })
  for (const entry of entries) {
    const source = posix.join(sourceRoot, entry.name)
    const target = posix.join(destination, entry.name)
    runWslPublishCommand({
      distribution: selectedDistribution,
      args: ['rm', '--recursive', '--force', '--', target],
      spawnImpl,
    })
    runWslPublishCommand({
      distribution: selectedDistribution,
      args: [
        'cp',
        ...(entry.isDirectory() ? ['--recursive'] : []),
        '--',
        source,
        target,
      ],
      spawnImpl,
    })
  }
}

export function parseWindowsBuilderArguments(argumentsList = []) {
  const result = {
    local: false,
    stageOutput: false,
    wslDistribution: '',
    wslProjectDirectory: '',
  }
  const seen = new Set()
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (seen.has(argument)) {
      throw new Error(`Duplicate Windows desktop build argument: ${argument}`)
    }
    seen.add(argument)
    if (argument === '--local') {
      result.local = true
    } else if (argument === '--stage-output') {
      result.stageOutput = true
    } else if (
      argument === '--wsl-distribution'
      || argument === '--wsl-project-directory'
    ) {
      const value = argumentsList[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for Windows desktop build argument: ${argument}`)
      }
      index += 1
      if (argument === '--wsl-distribution') result.wslDistribution = value
      else result.wslProjectDirectory = value
    } else {
      throw new Error(`Unsupported Windows desktop build argument: ${argument}`)
    }
  }
  const wslPublish = Boolean(
    result.wslDistribution || result.wslProjectDirectory,
  )
  if (
    wslPublish
    && (
      !result.stageOutput
      || !result.wslDistribution
      || !result.wslProjectDirectory
    )
  ) {
    throw new Error(
      'WSL publish arguments must be used together with --stage-output',
    )
  }
  return result
}

export function windowsBuilderInvocation({
  local = false,
  env = process.env,
  outputDirectory = '',
} = {}) {
  const builderEnv = { ...env }
  const args = [
    '--config',
    'desktop/electron-builder.yml',
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
  ]
  if (outputDirectory) {
    args.push(
      `--config.directories.output=${nativeWindowsOutputDirectory(outputDirectory)}`,
    )
  }
  if (local) {
    for (const name of SIGNING_ENVIRONMENT_KEYS) delete builderEnv[name]
    builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    args.push('--config.win.forceCodeSigning=false')
  } else {
    validateWindowsReleaseEnvironment(env)
    if (env.WIN_CSC_SUBJECT_NAME) {
      args.push(
        `--config.win.signtoolOptions.certificateSubjectName=${env.WIN_CSC_SUBJECT_NAME}`,
      )
    }
  }
  return { args, env: builderEnv }
}

export function runWindowsDesktopBuilder({
  local = false,
  env = process.env,
  spawnImpl = spawnSync,
  publishSpawnImpl = spawnSync,
  rootDirectory = root,
  platform = process.platform,
  stageOutput = false,
  wslDistribution = '',
  wslProjectDirectory = '',
  temporaryDirectory = tmpdir(),
  fileSystem = {
    cpSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
  },
} = {}) {
  const staged = shouldStageWindowsOutput({
    platform,
    rootDirectory,
    force: stageOutput,
  })
  const outputDirectory = staged
    ? fileSystem.mkdtempSync(join(
        temporaryDirectory,
        'qwen-audio-agent-desktop-',
      ))
    : ''
  const invocation = windowsBuilderInvocation({
    local,
    env,
    outputDirectory,
  })
  const cli = resolve(
    rootDirectory,
    'node_modules/electron-builder/out/cli/cli.js',
  )
  let built = false
  let published = false
  try {
    const result = spawnImpl(process.execPath, [cli, ...invocation.args], {
      cwd: rootDirectory,
      env: invocation.env,
      stdio: 'inherit',
      shell: false,
    })
    if (result?.error) throw result.error
    if (result?.status !== 0) {
      throw new Error('Windows desktop packaging failed')
    }
    built = true
    if (staged) {
      if (wslDistribution && wslProjectDirectory) {
        publishWindowsDesktopOutputThroughWsl({
          staging: outputDirectory,
          distribution: wslDistribution,
          projectDirectory: wslProjectDirectory,
          spawnImpl: publishSpawnImpl,
          fileSystem,
        })
      } else {
        publishWindowsDesktopOutput({
          staging: outputDirectory,
          destination: resolve(rootDirectory, 'dist/desktop'),
          fileSystem,
        })
      }
      published = true
      process.stdout.write(
        'Windows desktop output was built on a local drive and published.\n',
      )
    }
  } finally {
    if (staged && (!built || published)) {
      fileSystem.rmSync(outputDirectory, { recursive: true, force: true })
    }
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    runWindowsDesktopBuilder(
      parseWindowsBuilderArguments(process.argv.slice(2)),
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
