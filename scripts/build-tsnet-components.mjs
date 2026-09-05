import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'sidecars/tsnet')
const output = resolve(source, 'dist')
const targets = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'x64'],
]

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

for (const [platform, arch] of targets) {
  const goos = platform === 'win32' ? 'windows' : platform
  const goarch = arch === 'x64' ? 'amd64' : arch
  const executable = resolve(
    output,
    `qwaudio-tsnet-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`,
  )
  const built = spawnSync('go', [
    'build',
    '-trimpath',
    '-ldflags=-s -w',
    '-o', executable,
    '.',
  ], {
    cwd: source,
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: goos,
      GOARCH: goarch,
    },
    encoding: 'utf8',
  })
  if (built.status !== 0) {
    process.stderr.write(
      built.stderr || built.stdout || `Go build failed for ${platform}/${arch}\n`,
    )
    process.exit(built.status || 1)
  }
  const archiveName = `qwen-audio-agent-tsnet-${platform}-${arch}.gz`
  const archivePath = resolve(output, archiveName)
  const archive = gzipSync(readFileSync(executable), { level: 9 })
  writeFileSync(archivePath, archive)
  writeFileSync(
    `${archivePath}.sha256`,
    `${createHash('sha256').update(archive).digest('hex')}  ${archiveName}\n`,
  )
  rmSync(executable)
  process.stdout.write(`built ${archiveName}\n`)
}
