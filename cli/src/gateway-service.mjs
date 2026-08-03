import { execFile } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export const GATEWAY_SERVICE_LABEL = 'com.qwen-audio-agent.gateway'

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function systemd(value) {
  return `"${String(value)
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '')}"`
}

function executeFile(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
      } else {
        resolvePromise({ stdout, stderr })
      }
    })
  })
}

export function gatewayServiceDefinition({
  platform = process.platform,
  homeDirectory = homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME
    || resolve(homeDirectory, '.config'),
  configDirectory,
  nodePath = process.execPath,
  gatewayPath,
  pathEnvironment = process.env.PATH || '',
  serviceEnvironment = {},
  serviceMetadata = {},
} = {}) {
  if (!configDirectory) throw new Error('缺少 qwen-audio-agent 配置目录')
  if (!gatewayPath) throw new Error('缺少 qwen-audio-agent Gateway 路径')
  const logsDirectory = resolve(configDirectory, 'logs')
  const metadataPath = resolve(configDirectory, 'gateway-service.json')
  const command = [nodePath, gatewayPath]
  const workingDirectory = dirname(gatewayPath)
  const environment = {
    QWAUDIO_CONFIG_DIR: configDirectory,
    QWEN_AUDIO_GATEWAY_OWNER: 'service',
    QWEN_AUDIO_LOG_CONSOLE: '0',
    PATH: pathEnvironment,
    ...serviceEnvironment,
  }

  if (platform === 'darwin') {
    const servicePath = resolve(
      homeDirectory,
      'Library/LaunchAgents',
      `${GATEWAY_SERVICE_LABEL}.plist`,
    )
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${GATEWAY_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map(value => `    <string>${xml(value)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => (
    `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`
  )).join('\n')}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(resolve(logsDirectory, 'gateway-console.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(resolve(logsDirectory, 'gateway-console.log'))}</string>
</dict>
</plist>
`
    return {
      kind: 'launchd',
      servicePath,
      metadataPath,
      serviceMetadata,
      logsDirectory,
      logPath: resolve(logsDirectory, 'gateway.log'),
      content,
    }
  }

  if (platform === 'linux') {
    const servicePath = resolve(
      xdgConfigHome,
      'systemd/user/qwen-audio-agent-gateway.service',
    )
    const content = `[Unit]
Description=qwen-audio-agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemd(workingDirectory)}
ExecStart=${command.map(systemd).join(' ')}
${Object.entries(environment).map(([key, value]) => (
    `Environment=${systemd(`${key}=${value}`)}`
  )).join('\n')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group

[Install]
WantedBy=default.target
`
    return {
      kind: 'systemd',
      servicePath,
      metadataPath,
      serviceMetadata,
      logsDirectory,
      logPath: null,
      content,
    }
  }

  throw new Error(
    `当前系统暂不支持 Gateway 后台服务：${platform}`,
  )
}

function fileExists(path) {
  try {
    readFileSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function installDefinition(definition) {
  mkdirSync(dirname(definition.servicePath), {
    recursive: true,
    mode: 0o700,
  })
  mkdirSync(definition.logsDirectory, {
    recursive: true,
    mode: 0o700,
  })
  writeFileSync(definition.servicePath, definition.content, {
    encoding: 'utf8',
    mode: 0o600,
  })
  writeFileSync(
    definition.metadataPath,
    `${JSON.stringify(definition.serviceMetadata, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function removeDefinition(definition) {
  for (const path of [definition.servicePath, definition.metadataPath]) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function installedMetadata(definition) {
  try {
    return JSON.parse(readFileSync(definition.metadataPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function launchdLoaded(execute, domain) {
  try {
    await execute('launchctl', ['print', `${domain}/${GATEWAY_SERVICE_LABEL}`])
    return true
  } catch {
    return false
  }
}

async function launchdAction(action, definition, {
  execute,
  uid,
} = {}) {
  const domain = `gui/${uid}`
  const loaded = await launchdLoaded(execute, domain)
  const installed = fileExists(definition.servicePath)

  if (action === 'status') return { installed, running: loaded }
  if (action === 'install') {
    if (loaded) {
      await execute('launchctl', [
        'bootout',
        `${domain}/${GATEWAY_SERVICE_LABEL}`,
      ])
    }
    installDefinition(definition)
    await execute('launchctl', [
      'bootstrap',
      domain,
      definition.servicePath,
    ])
    return { installed: true, running: true }
  }
  if (action === 'uninstall') {
    if (loaded) {
      await execute('launchctl', [
        'bootout',
        `${domain}/${GATEWAY_SERVICE_LABEL}`,
      ])
    }
    removeDefinition(definition)
    return { installed: false, running: false }
  }
  if (!installed) {
    throw new Error(
      'Gateway 后台服务尚未安装；请先执行 qwenaudio gateway install',
    )
  }
  if (action === 'start') {
    if (loaded) {
      await execute('launchctl', [
        'kickstart',
        `${domain}/${GATEWAY_SERVICE_LABEL}`,
      ])
    } else {
      await execute('launchctl', [
        'bootstrap',
        domain,
        definition.servicePath,
      ])
    }
    return { installed: true, running: true }
  }
  if (action === 'restart') {
    if (loaded) {
      await execute('launchctl', [
        'kickstart',
        '-k',
        `${domain}/${GATEWAY_SERVICE_LABEL}`,
      ])
    } else {
      await execute('launchctl', [
        'bootstrap',
        domain,
        definition.servicePath,
      ])
    }
    return { installed: true, running: true }
  }
  if (action === 'stop') {
    if (loaded) {
      await execute('launchctl', [
        'bootout',
        `${domain}/${GATEWAY_SERVICE_LABEL}`,
      ])
    }
    return { installed: true, running: false }
  }
  throw new Error(`不支持的 Gateway 服务操作：${action}`)
}

async function systemdStatus(execute) {
  try {
    await execute('systemctl', [
      '--user',
      'is-active',
      '--quiet',
      'qwen-audio-agent-gateway.service',
    ])
    return true
  } catch {
    return false
  }
}

async function systemdAction(action, definition, { execute } = {}) {
  const unit = 'qwen-audio-agent-gateway.service'
  const installed = fileExists(definition.servicePath)
  if (action === 'status') {
    return {
      installed,
      running: installed ? await systemdStatus(execute) : false,
    }
  }
  if (action === 'install') {
    installDefinition(definition)
    await execute('systemctl', ['--user', 'daemon-reload'])
    await execute('systemctl', ['--user', 'enable', '--now', unit])
    return { installed: true, running: true }
  }
  if (action === 'uninstall') {
    if (installed) {
      try {
        await execute('systemctl', ['--user', 'disable', '--now', unit])
      } catch {
        // A stopped or partially installed unit can still be safely removed.
      }
    }
    removeDefinition(definition)
    await execute('systemctl', ['--user', 'daemon-reload'])
    return { installed: false, running: false }
  }
  if (!installed) {
    throw new Error(
      'Gateway 后台服务尚未安装；请先执行 qwenaudio gateway install',
    )
  }
  await execute('systemctl', ['--user', action, unit])
  return {
    installed: true,
    running: action !== 'stop',
  }
}

export async function manageGatewayService(action, {
  platform = process.platform,
  homeDirectory = homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME
    || resolve(homeDirectory, '.config'),
  configDirectory,
  nodePath = process.execPath,
  gatewayPath,
  pathEnvironment = process.env.PATH || '',
  serviceEnvironment = {},
  serviceMetadata = {},
  uid = process.getuid?.(),
  execute = executeFile,
} = {}) {
  const definition = gatewayServiceDefinition({
    platform,
    homeDirectory,
    xdgConfigHome,
    configDirectory,
    nodePath,
    gatewayPath,
    pathEnvironment,
    serviceEnvironment,
    serviceMetadata,
  })
  const options = { execute, uid }
  const state = definition.kind === 'launchd'
    ? await launchdAction(action, definition, options)
    : await systemdAction(action, definition, options)
  return {
    ...state,
    ...definition,
    installedMetadata: installedMetadata(definition),
  }
}
