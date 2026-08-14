import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  commandAvailable,
  spawnAndProxy,
} from './lib/launcher.mjs'

const binary = process.env.DEEPSEEK_HARNESS_ACP_BIN || 'dsh-acp-demo'
const configPath = process.env.DEEPSEEK_HARNESS_CONFIG
  || resolve(process.cwd(), 'cordis.yml')

function yamlScalar(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) } catch { return '' }
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'")
  }
  return text.replace(/\s+#.*$/, '').trim()
}

// dsh web stores provider credentials in Harness's owner-only credential
// document. The standalone ACP composition does not boot the Web profile's
// credential plugin, so bridge that official store into this one child only.
function storedDeepSeekCredential(env = process.env) {
  const dshHome = String(env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const path = join(dshHome, '.credentials.yaml')
  try {
    const stat = statSync(path)
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return ''
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find(value => /^\s*DEEPSEEK_API_KEY\s*:/.test(value))
    return yamlScalar(line?.replace(/^\s*DEEPSEEK_API_KEY\s*:/, ''))
  } catch {
    return ''
  }
}

const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim()
  || storedDeepSeekCredential()
if (!apiKey) {
  console.error('DeepSeek is not configured. Run `dsh web` and add your API key.')
  process.exit(1)
}
if (!commandAvailable(binary)) {
  console.error(
    'DeepSeek ACP runtime is not installed. Run: '
    + 'qwenaudio install deepseek',
  )
  process.exit(1)
}

await spawnAndProxy(binary, ['--config', configPath], {
  env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
})
