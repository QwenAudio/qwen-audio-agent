import { execFile } from 'node:child_process'
import { posix } from 'node:path'

const WSL_COMMAND_OPTIONS = Object.freeze({
  windowsHide: true,
  shell: false,
})
const INTERNAL_DISTRIBUTIONS = new Set([
  'docker-desktop',
  'docker-desktop-data',
])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export class WslDiscoveryError extends Error {
  constructor(reason, message, options) {
    super(message, options)
    this.name = 'WslDiscoveryError'
    this.reason = reason
  }
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return Buffer.from(String(value ?? ''), 'utf8')
}

function likelyUtf16Le(buffer) {
  if (buffer.length < 4) return false
  let oddNuls = 0
  let samples = 0
  for (let index = 1; index < buffer.length; index += 2) {
    samples += 1
    if (buffer[index] === 0) oddNuls += 1
  }
  return samples > 0 && oddNuls / samples > 0.3
}

export function decodeWslOutput(value) {
  const buffer = asBuffer(value)
  let text
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString('utf16le')
  } else if (
    buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf
  ) {
    text = buffer.subarray(3).toString('utf8')
  } else {
    text = buffer.toString(likelyUtf16Le(buffer) ? 'utf16le' : 'utf8')
  }
  return text.replace(/^\ufeff/, '').replaceAll('\u0000', '')
}

function validListedName(value) {
  const name = String(value ?? '').trim()
  if (!name || CONTROL_CHARACTERS.test(name)) return ''
  return name
}

export function parseWslDistributionList(value) {
  const names = []
  const seen = new Set()
  for (const line of decodeWslOutput(value).split(/\r?\n/)) {
    const name = validListedName(line)
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

export function parseWslVerboseList(value) {
  const distributions = []
  const seen = new Set()
  for (const rawLine of decodeWslOutput(value).split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || /^NAME\s+STATE\s+VERSION$/i.test(line)) continue
    let isDefault = false
    if (line.startsWith('*')) {
      isDefault = true
      line = line.slice(1).trimStart()
    }
    const match = line.match(/^(.+?)\s{2,}(.+?)\s{2,}([12])$/)
    if (!match) continue
    const name = validListedName(match[1])
    const state = String(match[2] || '').trim()
    const key = name.toLowerCase()
    if (!name || !state || CONTROL_CHARACTERS.test(state) || seen.has(key)) {
      continue
    }
    seen.add(key)
    distributions.push({
      name,
      state,
      version: Number(match[3]),
      isDefault,
    })
  }
  return distributions
}

function distributionName(item) {
  return typeof item === 'string' ? item : item?.name
}

function distributionDetails(distributions, name) {
  return distributions.find(item => distributionName(item) === name)
}

function automaticCandidates(distributions) {
  return distributions.filter(item => (
    !INTERNAL_DISTRIBUTIONS.has(
      String(distributionName(item) || '').toLowerCase(),
    )
  ))
}

function assertWsl2(item) {
  if (typeof item === 'object' && item?.version === 1) {
    throw new WslDiscoveryError(
      'wsl2-required',
      `Distribution ${item.name} must be upgraded to WSL2`,
    )
  }
}

export function assertDiscoveredDistribution(name, distributions) {
  const value = String(name ?? '')
  if (
    !value
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new WslDiscoveryError(
      'invalid-distribution',
      'Distribution name is invalid',
    )
  }
  const found = distributions.find(item => distributionName(item) === value)
  if (!found) {
    throw new WslDiscoveryError(
      'distribution-not-found',
      `Distribution is not present in the current WSL list: ${value}`,
    )
  }
  return distributionName(found)
}

export function selectWslDistribution({
  distributions,
  configured = '',
  defaultName = '',
} = {}) {
  if (!Array.isArray(distributions)) {
    throw new TypeError('distributions must be an array')
  }
  if (configured) {
    const selected = assertDiscoveredDistribution(configured, distributions)
    assertWsl2(distributionDetails(distributions, selected))
    return selected
  }
  const candidates = automaticCandidates(distributions)
  let selected = defaultName
    ? distributionDetails(candidates, defaultName)
    : null
  selected ||= candidates.find(item => (
    typeof item === 'object' && item?.isDefault
  ))
  selected ||= candidates[0]
  if (!selected) {
    throw new WslDiscoveryError(
      'no-distributions',
      'No user WSL distributions are available',
    )
  }
  assertWsl2(selected)
  return distributionName(selected)
}

function assertStructuredValue(value, label, { allowEmpty = false } = {}) {
  const text = String(value ?? '')
  if ((!allowEmpty && !text) || CONTROL_CHARACTERS.test(text)) {
    throw new Error(`${label} is invalid`)
  }
  return text
}

function structuredArguments(args) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array')
  return args.map((value, index) => assertStructuredValue(
    value,
    `argument ${index}`,
    { allowEmpty: true },
  ))
}

export function buildWslCommand({ distribution, executable, args = [] }) {
  return {
    file: 'wsl.exe',
    args: [
      '--distribution',
      assertStructuredValue(distribution, 'distribution'),
      '--exec',
      assertStructuredValue(executable, 'executable'),
      ...structuredArguments(args),
    ],
    options: { ...WSL_COMMAND_OPTIONS },
  }
}

export function buildWslLoginCommand({
  distribution,
  executable,
  args = [],
}) {
  return {
    file: 'wsl.exe',
    args: [
      '--distribution',
      assertStructuredValue(distribution, 'distribution'),
      '--exec', 'bash', '-lic', 'exec "$@"',
      'qwaudio-desktop',
      assertStructuredValue(executable, 'executable'),
      ...structuredArguments(args),
    ],
    options: { ...WSL_COMMAND_OPTIONS },
  }
}

function basicWslCommand(args) {
  return {
    file: 'wsl.exe',
    args,
    options: { ...WSL_COMMAND_OPTIONS },
  }
}

export function executeWslCommand(command, execFileImpl = execFile) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(command.file, command.args, {
      ...command.options,
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout, stderr, code: 0 })
    })
  })
}

function resultStdout(result) {
  return result && typeof result === 'object' && 'stdout' in result
    ? result.stdout
    : result
}

function assertSuccessfulResult(result, reason) {
  if (result?.code !== undefined && result.code !== 0) {
    throw new WslDiscoveryError(reason, `WSL command failed with ${result.code}`)
  }
  return result
}

async function runDiscoveryCommand(
  runCommand,
  command,
  reason,
  { allowFailure = false } = {},
) {
  try {
    return assertSuccessfulResult(await runCommand(command), reason)
  } catch (error) {
    if (allowFailure) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
    }
    if (error instanceof WslDiscoveryError) throw error
    throw new WslDiscoveryError(reason, `WSL command failed during ${reason}`)
  }
}

export const WSL_RUNTIME_PROBE_SOURCE = [
  "const fs=require('node:fs');",
  "const os=require('node:os');",
  "const path=require('node:path');",
  "const cp=require('node:child_process');",
  'const home=os.homedir();',
  "const run=(file,args)=>cp.spawnSync(file,args,{encoding:'utf8'});",
  "const uname=run('uname',['-m']);",
  "const npm=run('npm',['--version']);",
  'const value={version:1,home,',
  "distribution:String(process.env.WSL_DISTRO_NAME||''),",
  "architecture:String(uname.stdout||'').trim(),",
  'nodeVersion:process.version,',
  "npmVersion:npm.status===0?String(npm.stdout||'').trim():'',",
  'runtime:{currentMarkerExists:fs.existsSync(path.join(home,',
  "'.local','share','qwaudio','windows-client','current.json'))}};",
  "process.stdout.write(JSON.stringify(value)+'\\n');",
].join('')

function defaultDistributionQueryCommand() {
  return basicWslCommand([
    '--exec', 'sh', '-c',
    'printf "%s" "$WSL_DISTRO_NAME"',
  ])
}

function mergeDistributionDetails(names, verbose) {
  const details = new Map(verbose.map(item => [item.name, item]))
  const merged = names.map(name => details.get(name) || {
    name,
    state: 'Unknown',
    version: null,
    isDefault: false,
  })
  for (const item of verbose) {
    if (!merged.some(candidate => candidate.name === item.name)) merged.push(item)
  }
  return merged
}

function cleanSingleLine(value, label, { allowEmpty = false } = {}) {
  const text = decodeWslOutput(value).trim()
  if ((!allowEmpty && !text) || CONTROL_CHARACTERS.test(text)) {
    throw new WslDiscoveryError('invalid-probe', `${label} is invalid`)
  }
  return text
}

function assertAbsoluteWslPath(value, label) {
  const text = String(value ?? '')
  if (!text.startsWith('/') || CONTROL_CHARACTERS.test(text) || text.includes('\\')) {
    throw new WslDiscoveryError('invalid-probe', `${label} must be an absolute WSL path`)
  }
  return text
}

function parseRuntimeProbe(value, selected) {
  let probe
  try {
    probe = JSON.parse(decodeWslOutput(value).trim())
  } catch (error) {
    throw new WslDiscoveryError(
      'invalid-probe',
      'WSL runtime probe did not return valid JSON',
      { cause: error },
    )
  }
  if (
    probe?.version !== 1
    || probe.distribution !== selected
    || typeof probe.architecture !== 'string'
    || !probe.architecture
    || typeof probe.nodeVersion !== 'string'
    || typeof probe.npmVersion !== 'string'
    || !probe.runtime
    || typeof probe.runtime !== 'object'
  ) {
    throw new WslDiscoveryError(
      'invalid-probe',
      'WSL runtime probe returned an invalid contract',
    )
  }
  return {
    ...probe,
    home: assertAbsoluteWslPath(probe.home, 'Probe home'),
  }
}

export async function probeWslRuntime({
  configured = '',
  runCommand = executeWslCommand,
} = {}) {
  const statusResult = await runDiscoveryCommand(
    runCommand,
    basicWslCommand(['--status']),
    'wsl-unavailable',
  )
  const quietResult = await runDiscoveryCommand(
    runCommand,
    basicWslCommand(['--list', '--quiet']),
    'wsl-unavailable',
  )
  const verboseResult = await runDiscoveryCommand(
    runCommand,
    basicWslCommand(['--list', '--verbose']),
    'wsl-unavailable',
  )
  const defaultResult = await runDiscoveryCommand(
    runCommand,
    defaultDistributionQueryCommand(),
    'wsl-unavailable',
    { allowFailure: true },
  )
  const names = parseWslDistributionList(resultStdout(quietResult))
  const verbose = parseWslVerboseList(resultStdout(verboseResult))
  const distributions = mergeDistributionDetails(names, verbose)
  const defaultName = cleanSingleLine(
    resultStdout(defaultResult),
    'Default distribution',
    { allowEmpty: true },
  )
  const selected = selectWslDistribution({
    distributions,
    configured,
    defaultName,
  })
  const probeResult = await runDiscoveryCommand(
    runCommand,
    buildWslLoginCommand({
      distribution: selected,
      executable: 'node',
      args: ['--eval', WSL_RUNTIME_PROBE_SOURCE],
    }),
    'node-required',
  )
  return {
    status: decodeWslOutput(resultStdout(statusResult)),
    distributions,
    defaultName,
    selected,
    probe: parseRuntimeProbe(resultStdout(probeResult), selected),
  }
}

function assertAbsoluteWindowsPath(value) {
  const text = String(value ?? '')
  const drivePath = /^[A-Za-z]:[\\/]/.test(text)
  const uncPath = /^\\\\[^\\/]+[\\/][^\\/]+/.test(text)
  if (
    !text
    || text !== text.trim()
    || CONTROL_CHARACTERS.test(text)
    || (!drivePath && !uncPath)
  ) {
    throw new Error('Expected an absolute Windows path')
  }
  return text
}

export async function convertWindowsPathToWsl({
  distribution,
  windowsPath,
  runCommand = executeWslCommand,
} = {}) {
  const command = buildWslCommand({
    distribution,
    executable: 'wslpath',
    args: ['-a', '-u', assertAbsoluteWindowsPath(windowsPath)],
  })
  const result = assertSuccessfulResult(
    await runCommand(command),
    'wslpath-failed',
  )
  const converted = decodeWslOutput(resultStdout(result)).trim()
  if (
    !converted.startsWith('/')
    || CONTROL_CHARACTERS.test(converted)
    || converted.includes('\\')
    || posix.normalize(converted) !== converted
  ) {
    throw new Error('wslpath must return one absolute WSL path')
  }
  return converted
}
