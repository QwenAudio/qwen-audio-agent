import { spawn } from 'node:child_process'
import { backendAuthenticationSupport } from '../../shared/backend-lifecycle.mjs'

function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function terminalLaunch(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const authentication = backendAuthenticationSupport(id, { env, platform })
  if (!authentication.required || !authentication.supported) return null
  const command = authentication.command
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e', 'tell application "Terminal"',
        '-e', 'activate',
        '-e', `do script ${appleScriptString(command)}`,
        '-e', 'end tell',
      ],
    }
  }
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', command],
    }
  }
  return {
    command: 'x-terminal-emulator',
    args: ['-e', 'sh', '-lc', `${command}; exec "\${SHELL:-/bin/sh}" -l`],
  }
}

export async function openBackendAuthentication(id, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const launch = terminalLaunch(id, { env, platform })
  if (!launch) throw new Error('该后台 Agent 不需要或不支持桌面登录')
  const child = spawnImpl(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref?.()
      resolve(true)
    })
  })
}
