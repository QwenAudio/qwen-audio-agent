import {
  accessSync,
  constants,
  existsSync,
} from 'node:fs'
import {
  delimiter,
  extname,
  isAbsolute,
  resolve,
} from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  backendDefinition,
  backendNames,
} from './backend-catalog.mjs'

const SPECS = {
  opencode: {
    command: 'opencode',
    executableEnvironment: 'OPENCODE_BIN',
    integration: 'native',
    minimumVersion: '1.18.0',
  },
  openclaw: {
    command: 'openclaw',
    executableEnvironment: 'OPENCLAW_BIN',
    integration: 'bridge',
  },
  qoder: {
    command: 'qodercli',
    executableEnvironment: ['QODERCLI_PATH', 'QODER_CLI_PATH'],
    integration: 'native',
  },
  kimi: {
    command: 'kimi',
    executableEnvironment: 'KIMI_CODE_BIN',
    integration: 'native',
    minimumVersion: '0.31.0',
  },
  hermes: {
    command: 'hermes',
    executableEnvironment: 'HERMES_BIN',
    integration: 'native',
  },
  codebuddy: {
    command: 'codebuddy',
    executableEnvironment: 'CODEBUDDY_BIN',
    integration: 'native',
  },
  codex: {
    command: 'codex',
    executableEnvironment: 'CODEX_PATH',
    integration: 'adapter',
    adapterCommand: 'codex-acp',
    adapterEnvironment: 'CODEX_ACP_BIN',
    adapterRuntimeEnvironment: 'CODEX_ACP_RUNTIME',
  },
  claude: {
    command: 'claude',
    executableEnvironment: 'CLAUDE_CODE_EXECUTABLE',
    integration: 'adapter',
    adapterCommand: 'claude-code-acp',
    adapterEnvironment: 'CLAUDE_CODE_ACP_BIN',
    adapterRuntimeEnvironment: 'CLAUDE_CODE_ACP_RUNTIME',
  },
  acp: {
    commandEnvironment: 'ACP_COMMAND',
    integration: 'generic',
  },
}

function clean(value) {
  return String(value || '').trim()
}

function environmentValue(env, names) {
  for (const name of [names].flat()) {
    const value = clean(env[name])
    if (value) return { name, value }
  }
  return { name: [names].flat()[0], value: '' }
}

function expandHome(value, env) {
  if (value === '~') return clean(env.HOME || env.USERPROFILE) || value
  if (!value.startsWith('~/') && !value.startsWith('~\\')) return value
  const home = clean(env.HOME || env.USERPROFILE)
  return home ? resolve(home, value.slice(2)) : value
}

function executableExtensions(platform, env) {
  if (platform !== 'win32') return ['']
  return clean(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(value => value.toLowerCase())
}

function executableFile(path, platform) {
  try {
    accessSync(
      path,
      platform === 'win32' ? constants.F_OK : constants.X_OK,
    )
    return true
  } catch {
    return false
  }
}

export function findExecutable(command, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const value = expandHome(clean(command), env)
  if (!value) return ''
  const extensions = executableExtensions(platform, env)
  const hasPath = isAbsolute(value) || /[/\\]/.test(value)
  const directories = hasPath
    ? ['']
    : clean(env.PATH).split(delimiter).filter(Boolean)
  const suffixes = platform === 'win32' && !extname(value)
    ? ['', ...extensions]
    : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory
        ? resolve(directory, `${value}${suffix}`)
        : resolve(`${value}${suffix}`)
      if (executableFile(candidate, platform)) return candidate
    }
  }
  return ''
}

function versionTuple(value) {
  const match = clean(value).match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : null
}

function versionAtLeast(actual, minimum) {
  const left = versionTuple(actual)
  const right = versionTuple(minimum)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true
    if (left[index] < right[index]) return false
  }
  return true
}

function defaultReadVersion(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (result.status !== 0) return ''
  return clean(result.stdout || result.stderr).split(/\r?\n/)[0]
}

function explicitRuntime(id, env, find) {
  if (id === 'opencode') {
    const runtime = clean(env.OPENCODE_RUNTIME || 'auto').toLowerCase()
    if (!['auto', 'binary', 'installed', 'package', 'source'].includes(runtime)) {
      return { ready: false, issue: `不支持的 OPENCODE_RUNTIME：${runtime}` }
    }
    if (runtime === 'package') {
      const npx = find('npx')
      return npx
        ? { ready: true, source: 'package', path: npx }
        : { ready: false, issue: 'package 模式需要 npx' }
    }
    if (runtime === 'binary' || (runtime === 'auto' && clean(env.OPENCODE_BIN))) {
      const path = find(env.OPENCODE_BIN)
      return path
        ? { ready: true, source: 'configured', path }
        : { ready: false, issue: 'OPENCODE_BIN 指定的 OpenCode 不可用' }
    }
    if (runtime === 'source' || clean(env.OPENCODE_SOURCE_DIR)) {
      const directory = clean(env.OPENCODE_SOURCE_DIR)
      const entry = directory
        ? resolve(directory, 'packages/opencode/src/index.ts')
        : ''
      const dependency = directory
        ? resolve(directory, 'node_modules/@opencode-ai/tui')
        : ''
      const bun = find(env.BUN_BIN || 'bun')
      return entry && existsSync(entry) && existsSync(dependency) && bun
        ? { ready: true, source: 'source', path: directory }
        : { ready: false, issue: 'OpenCode 源码目录或 Bun 不可用' }
    }
    if (runtime === 'installed') {
      const path = find('opencode')
      return path
        ? { ready: true, source: 'installed', path }
        : { ready: false, issue: 'PATH 中未找到 OpenCode' }
    }
  }
  if (id === 'openclaw') {
    const runtime = clean(env.OPENCLAW_RUNTIME || 'auto').toLowerCase()
    if (![
      'auto',
      'binary',
      'installed',
      'bundle',
      'package',
      'source',
    ].includes(runtime)) {
      return { ready: false, issue: `不支持的 OPENCLAW_RUNTIME：${runtime}` }
    }
    if (runtime === 'package') {
      const npx = find('npx')
      return npx
        ? { ready: true, source: 'package', path: npx }
        : { ready: false, issue: 'package 模式需要 npx' }
    }
    if (runtime === 'binary' || (runtime === 'auto' && clean(env.OPENCLAW_BIN))) {
      const path = find(env.OPENCLAW_BIN)
      return path
        ? { ready: true, source: 'configured', path }
        : { ready: false, issue: 'OPENCLAW_BIN 指定的 OpenClaw 不可用' }
    }
    if (runtime === 'source' || clean(env.OPENCLAW_SOURCE_DIR)) {
      const directory = clean(env.OPENCLAW_SOURCE_DIR)
      const manifest = directory ? resolve(directory, 'package.json') : ''
      const corepack = find('corepack')
      return manifest && existsSync(manifest) && corepack
        ? { ready: true, source: 'source', path: directory }
        : { ready: false, issue: 'OpenClaw 源码目录或 corepack 不可用' }
    }
    const bundle = expandHome(
      clean(env.OPENCLAW_BUNDLE_BIN)
      || `${clean(env.HOME)}/.openclaw-bundle/wrapper/openclaw`,
      env,
    )
    if (['auto', 'bundle'].includes(runtime) && bundle) {
      const path = find(bundle)
      if (path) return { ready: true, source: 'bundle', path }
    }
    if (runtime === 'bundle') {
      return { ready: false, issue: 'OpenClaw Bundle 不可用' }
    }
    if (runtime === 'installed') {
      const path = find('openclaw')
      return path
        ? { ready: true, source: 'installed', path }
        : { ready: false, issue: 'PATH 中未找到 OpenClaw' }
    }
  }
  return null
}

function inspectAdapter(spec, env, find) {
  if (!spec.adapterCommand) {
    return { ready: true, source: spec.integration }
  }
  const runtime = clean(
    env[spec.adapterRuntimeEnvironment] || 'auto',
  ).toLowerCase()
  const configured = environmentValue(env, spec.adapterEnvironment)
  if (!['auto', 'binary', 'package'].includes(runtime)) {
    return {
      ready: false,
      issue: `不支持的 ${spec.adapterRuntimeEnvironment}：${runtime}`,
    }
  }
  if (runtime === 'package') {
    const npx = find('npx')
    return npx
      ? { ready: true, source: 'managed', path: npx }
      : { ready: false, issue: 'ACP Adapter package 模式需要 npx' }
  }
  if (configured.value) {
    const path = find(configured.value)
    return path
      ? { ready: true, source: 'installed', path }
      : {
          ready: false,
          issue: `${configured.name} 指定的 ACP Adapter 不可用`,
        }
  }
  const installed = find(spec.adapterCommand)
  if (installed) {
    return { ready: true, source: 'installed', path: installed }
  }
  if (runtime === 'binary') {
    return {
      ready: false,
      issue: `${spec.adapterCommand} 不可用`,
    }
  }
  const npx = find('npx')
  if (npx) return { ready: true, source: 'managed', path: npx }
  return {
    ready: false,
    issue: `缺少 ${spec.adapterCommand}，并且 npx 不可用`,
  }
}

function inspectBackend(id, {
  env,
  platform,
  find,
  readVersion,
  selected,
}) {
  const definition = backendDefinition(id)
  const spec = SPECS[id]
  const configured = spec.commandEnvironment
    ? environmentValue(env, spec.commandEnvironment)
    : environmentValue(env, spec.executableEnvironment)
  const command = configured.value || spec.command
  const runtimeEnvironment = id === 'opencode'
    ? 'OPENCODE_RUNTIME'
    : id === 'openclaw' ? 'OPENCLAW_RUNTIME' : ''
  const runtime = runtimeEnvironment
    ? clean(env[runtimeEnvironment] || 'auto').toLowerCase()
    : ''
  const automaticBailian = (
    ['opencode', 'openclaw'].includes(id)
    && Boolean(clean(env.DASHSCOPE_API_KEY))
    && Boolean(clean(env.QWEN_AUDIO_AGENT_BACKEND_MODEL))
    && clean(env.QWEN_AUDIO_AGENT_BACKEND_MODEL).toLowerCase() !== 'auto'
  )
  let backend = explicitRuntime(id, env, find)
  if (!backend) {
    const path = find(command)
    backend = path
      ? {
          ready: true,
          source: configured.value ? 'configured' : 'installed',
          path,
        }
      : {
          ready: false,
          issue: configured.value
            ? `${configured.name} 指定的命令不可用：${configured.value}`
            : spec.commandEnvironment
              ? `请设置 ${spec.commandEnvironment}`
              : `未找到 ${definition.label}，请先安装并完成原生配置`,
        }
    if (
      !backend.ready
      && ['opencode', 'openclaw'].includes(id)
      && runtime === 'auto'
    ) {
      const npx = find('npx')
      if (npx && automaticBailian) {
        backend = {
          ready: true,
          source: 'managed',
          path: npx,
        }
      } else if (npx) {
        backend.issue = `未找到 ${definition.label}；自动部署需要 `
          + 'DASHSCOPE_API_KEY 和 QWEN_AUDIO_AGENT_BACKEND_MODEL'
      }
    }
  }

  if (
    backend.ready
    && id === 'opencode'
    && backend.source === 'installed'
  ) {
    const version = readVersion(backend.path)
    backend.version = version
    if (!versionAtLeast(version, spec.minimumVersion)) {
      const npx = runtime === 'auto' ? find('npx') : ''
      if (npx && automaticBailian) {
        backend = {
          ready: true,
          source: 'managed',
          path: npx,
          fallbackFromVersion: version,
        }
      } else {
        backend.ready = false
        backend.issue = npx
          ? `OpenCode ${version || '版本未知'} 不兼容；自动部署需要 `
            + 'DASHSCOPE_API_KEY 和 QWEN_AUDIO_AGENT_BACKEND_MODEL'
          : version
            ? `OpenCode ${version} 低于最低版本 ${spec.minimumVersion}`
            : '无法确认 OpenCode 版本'
      }
    }
  }

  if (backend.ready && id === 'kimi') {
    const version = readVersion(backend.path)
    backend.version = version
    if (!versionAtLeast(version, spec.minimumVersion)) {
      backend.ready = false
      backend.issue = version
        ? `Kimi Code ${version} 低于最低版本 ${spec.minimumVersion}`
        : '无法确认 Kimi Code 版本'
    }
  }

  const adapter = backend.ready
    ? inspectAdapter(spec, env, find)
    : { ready: spec.integration !== 'adapter', source: spec.integration }
  const issues = [backend.issue, adapter.issue].filter(Boolean)
  return {
    id,
    label: definition.label,
    selected: id === selected,
    ready: backend.ready && adapter.ready,
    backend,
    adapter,
    integration: spec.integration,
    configuration: id === 'acp'
      ? 'command-managed'
      : automaticBailian ? 'automatic-bailian' : 'preserved',
    authentication: 'backend-managed',
    issues,
    platform,
  }
}

export function inspectBackendSetups({
  env = process.env,
  platform = process.platform,
  backend = '',
  find = command => findExecutable(command, { env, platform }),
  readVersion = defaultReadVersion,
} = {}) {
  const selected = clean(backend || env.AGENT_PROTOCOL).toLowerCase()
  const ids = backend ? [clean(backend).toLowerCase()] : backendNames()
  return {
    selected,
    readOnly: true,
    backends: ids.map(id => inspectBackend(id, {
      env,
      platform,
      find,
      readVersion,
      selected,
    })),
  }
}

function integrationText(item) {
  if (item.integration === 'native') return '原生 ACP'
  if (item.integration === 'bridge') return '内置 ACP Bridge'
  if (item.integration === 'generic') return '用户提供的 ACP 命令'
  if (item.adapter.source === 'managed') return 'ACP Adapter 由 npx 按需启动'
  return 'ACP Adapter 已安装'
}

function backendText(item) {
  if (!item.backend.ready) return item.backend.issue
  if (item.backend.source === 'managed') {
    return `启动时通过 npx 自动下载兼容版本（${item.backend.path}）`
  }
  if (item.backend.source === 'package') return `显式 package 模式（${item.backend.path}）`
  if (item.backend.source === 'source') return `源码模式（${item.backend.path}）`
  if (item.backend.source === 'bundle') return `Bundle（${item.backend.path}）`
  return item.backend.path
}

export function formatBackendSetup(report) {
  const lines = [
    '后台 Agent Setup（只读，不会安装、登录或修改配置）',
    report.selected
      ? `当前选择：${backendDefinition(report.selected)?.label || report.selected}`
      : '当前选择：未设置',
    '',
  ]
  for (const item of report.backends) {
    const details = item.ready
      ? [
          backendText(item),
          integrationText(item),
          item.configuration === 'automatic-bailian'
            ? '自动配置百炼 API Key 与后台模型'
            : item.configuration === 'preserved'
              ? '复用用户级配置'
              : '配置由 ACP Agent 管理',
        ]
      : item.issues
    lines.push(
      `${item.ready ? '✓' : '✗'} ${item.label}${item.selected ? ' [当前]' : ''}`,
      `  ${details.join(' · ')}`,
    )
    lines.push('')
  }
  lines.push(
    '默认不覆盖后台模型；认证由后台 Agent 管理，此命令不会输出或验证凭据。',
    'OpenCode 和 OpenClaw 可在启动时自动下载；配置百炼 API Key 与后台模型后可一键接入。',
    '其他后台请先确认在原生终端中可以正常工作。',
  )
  return lines.join('\n')
}
