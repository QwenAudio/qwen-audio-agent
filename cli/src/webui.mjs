import { spawn } from 'node:child_process'

export function webUiUrl(baseUrl, sessionId) {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  url.searchParams.set('session', sessionId)
  return url.toString()
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    return {
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return { command: 'xdg-open', args: [url] }
}

export function openBrowser(url, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const spec = browserCommand(url, platform)
  return new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref?.()
      resolve()
    })
  })
}

export async function launchWebUi(options, {
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
} = {}) {
  const pageUrl = webUiUrl(
    options.url,
    options.sessionId,
  )
  stdout.write(`qwenaudio WebUI: ${pageUrl}\n`)
  if (options.openBrowser) {
    try {
      await openBrowser(pageUrl, { platform, spawnImpl })
    } catch (error) {
      stderr.write(`未能自动打开浏览器：${error.message}\n`)
    }
  }

  return 0
}
