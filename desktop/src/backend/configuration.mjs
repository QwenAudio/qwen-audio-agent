import { spawn } from 'node:child_process'
import { backendConfigurationAction } from '../../../shared/backend-onboarding.mjs'

function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function configurationLaunches(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const action = backendConfigurationAction(id, { env, platform })
  if (!action || action.kind !== 'terminal') return []
  const command = action.command
  if (platform === 'darwin') {
    return [{
      action,
      command: '/usr/bin/osascript',
      args: [
        '-e', 'tell application "Terminal"',
        '-e', 'activate',
        '-e', `do script ${appleScriptString(command)}`,
        '-e', 'end tell',
      ],
    }]
  }
  if (platform === 'win32') {
    return [{
      action,
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', command],
    }]
  }
  const shellCommand = `${command}; exec "\${SHELL:-/bin/sh}" -l`
  return [
    { action, command: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', shellCommand] },
    { action, command: 'gnome-terminal', args: ['--', 'sh', '-lc', shellCommand] },
    { action, command: 'konsole', args: ['-e', 'sh', '-lc', shellCommand] },
    { action, command: 'xterm', args: ['-e', 'sh', '-lc', shellCommand] },
  ]
}

export function configurationLaunch(id, options = {}) {
  return configurationLaunches(id, options)[0] || null
}

export async function openBackendConfiguration(id, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const launches = configurationLaunches(id, { env, platform })
  if (!launches.length) throw new Error('该后台 Agent 没有可用的配置入口')
  return new Promise((resolve, reject) => {
    const attempt = index => {
      const launch = launches[index]
      if (!launch) {
        reject(new Error('没有找到可用的终端程序'))
        return
      }
      let child
      try {
        child = spawnImpl(launch.command, launch.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        })
      } catch (error) {
        if (platform === 'linux') attempt(index + 1)
        else reject(error)
        return
      }
      let launched = false
      child.once('error', error => {
        if (launched) return
        if (platform === 'linux') attempt(index + 1)
        else reject(error)
      })
      child.once('spawn', () => {
        launched = true
        child.unref?.()
        resolve({ ok: true, action: launch.action })
      })
    }
    attempt(0)
  })
}
