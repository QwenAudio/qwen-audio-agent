#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../shared/desktop-host-protocol.mjs'
import { parsePackOutput } from './verify-package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_PACKAGE_NAME = 'qwen-audio-agent'

const defaultFileSystem = {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
}

async function readJson(fileSystem, path, label) {
  let value
  try {
    value = JSON.parse(await fileSystem.readFile(path, 'utf8'))
  } catch {
    throw new Error(`Unable to read ${label}`)
  }
  return value
}

function expectedTarballName(version) {
  return `${EXPECTED_PACKAGE_NAME}-${version}.tgz`
}

export function validatePackEntry(entry, { packageName, packageVersion }) {
  if (entry?.name !== packageName || packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error('npm pack returned an unexpected package name')
  }
  if (entry.version !== packageVersion) {
    throw new Error('npm pack returned an unexpected package version')
  }
  const filename = String(entry.filename || '')
  if (
    !filename
    || filename !== basename(filename)
    || filename.includes('/')
    || filename.includes('\\')
    || filename !== expectedTarballName(packageVersion)
  ) throw new Error('npm pack returned an unsafe or unexpected filename')
  return filename
}

function npmInvocation(npmCommand) {
  if (npmCommand) return { command: npmCommand, prefix: [] }
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      prefix: [process.env.npm_execpath],
    }
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
  }
}

async function publishDirectory({ fileSystem, stagingDirectory, outputDirectory }) {
  const parent = dirname(outputDirectory)
  const backupDirectory = await fileSystem.mkdtemp(join(parent, '.wsl-runtime-backup-'))
  await fileSystem.rm(backupDirectory, { recursive: true, force: true })
  let hadPrevious = false
  try {
    await fileSystem.rename(outputDirectory, backupDirectory)
    hadPrevious = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await fileSystem.rename(stagingDirectory, outputDirectory)
  } catch (error) {
    if (hadPrevious) {
      await fileSystem.rename(backupDirectory, outputDirectory).catch(() => {})
    }
    throw error
  }
  if (hadPrevious) {
    await fileSystem.rm(backupDirectory, { recursive: true, force: true })
  }
}

export async function buildWslRuntimePayload({
  rootDirectory = root,
  outputDirectory = resolve(rootDirectory, 'dist/wsl-runtime'),
  protocolVersion = DESKTOP_HOST_PROTOCOL_VERSION,
  spawnImpl = spawnSync,
  fileSystem = defaultFileSystem,
  npmCommand,
} = {}) {
  const packageManifest = await readJson(
    fileSystem,
    resolve(rootDirectory, 'package.json'),
    'root package manifest',
  )
  const desktopManifest = await readJson(
    fileSystem,
    resolve(rootDirectory, 'desktop/package.json'),
    'desktop package manifest',
  )
  if (packageManifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error('Unexpected repository package name')
  }
  if (desktopManifest.version !== packageManifest.version) {
    throw new Error('Desktop version must match the WSL payload version')
  }
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error('Desktop host protocol version must be a positive integer')
  }

  const outputParent = dirname(outputDirectory)
  await fileSystem.mkdir(outputParent, { recursive: true })
  const stagingDirectory = await fileSystem.mkdtemp(
    join(outputParent, '.wsl-runtime-build-'),
  )
  let published = false
  try {
    const invocation = npmInvocation(npmCommand)
    const args = [
      ...invocation.prefix,
      'pack',
      '--json',
      '--pack-destination',
      stagingDirectory,
    ]
    const result = spawnImpl(invocation.command, args, {
      cwd: rootDirectory,
      env: process.env,
      encoding: 'utf8',
      shell: !npmCommand && !process.env.npm_execpath && process.platform === 'win32',
    })
    if (result?.error) throw result.error
    if (result?.status !== 0) {
      throw new Error('npm pack failed while building the WSL runtime payload')
    }
    const packages = parsePackOutput(String(result.stdout || ''))
    if (packages.length !== 1) {
      throw new Error('npm pack returned an unexpected package count')
    }
    const tarball = validatePackEntry(packages[0], {
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
    })
    const tarballPath = join(stagingDirectory, tarball)
    const tarballBytes = await fileSystem.readFile(tarballPath)
    const sha256 = createHash('sha256').update(tarballBytes).digest('hex')
    const manifest = {
      schemaVersion: 1,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      desktopVersion: desktopManifest.version,
      protocolVersion,
      sha256,
      tarball,
    }
    const temporaryManifest = join(stagingDirectory, '.manifest.json.tmp')
    await fileSystem.writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    )
    await fileSystem.rename(temporaryManifest, join(stagingDirectory, 'manifest.json'))
    const stagedFiles = (await fileSystem.readdir(stagingDirectory)).sort()
    if (stagedFiles.join('\n') !== ['manifest.json', tarball].sort().join('\n')) {
      throw new Error('WSL runtime staging directory contains unexpected files')
    }
    await publishDirectory({ fileSystem, stagingDirectory, outputDirectory })
    published = true
    return {
      manifest,
      manifestPath: join(outputDirectory, 'manifest.json'),
      tarballPath: join(outputDirectory, tarball),
    }
  } finally {
    if (!published) {
      await fileSystem.rm(stagingDirectory, { recursive: true, force: true })
    }
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const result = await buildWslRuntimePayload()
    process.stdout.write(
      `WSL runtime payload built: ${result.manifest.tarball} (${result.manifest.sha256})\n`,
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
