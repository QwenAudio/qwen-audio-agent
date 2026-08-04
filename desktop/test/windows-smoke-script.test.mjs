import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scriptUrl = new URL('../../scripts/windows-smoke-test.ps1', import.meta.url)

test('Windows smoke test launches one explicit executable and waits for a window', async () => {
  const source = await readFile(scriptUrl, 'utf8')

  assert.match(source, /Set-StrictMode -Version Latest/)
  assert.match(source, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/)
  assert.match(source, /\[Parameter\(Mandatory\s*=\s*\$true\)\]/)
  assert.match(source, /\[string\]\$ExecutablePath/)
  assert.equal((source.match(/\[string\]\$[A-Za-z]+/g) || []).length, 1)
  assert.match(source, /Resolve-Path\s+-LiteralPath\s+\$ExecutablePath/)
  assert.match(source, /Start-Process[\s\S]*-PassThru/)
  assert.match(source, /--user-data-dir=/)
  assert.match(source, /MainWindowHandle/)
  assert.match(source, /AddSeconds\([1-9]\d*\)/)
  assert.match(source, /Start-Sleep\s+-Milliseconds/)
})

test('Windows smoke cleanup is isolated to the launched PID', async () => {
  const source = await readFile(scriptUrl, 'utf8')

  assert.match(source, /try\s*\{/)
  assert.match(source, /finally\s*\{/)
  assert.match(source, /Stop-Process\s+-Id\s+\$process\.Id/)
  assert.doesNotMatch(source, /Stop-Process\s+-Name/i)
  assert.doesNotMatch(source, /\btaskkill\b/i)
  assert.doesNotMatch(source, /wsl(?:\.exe)?\s+--shutdown/i)
  assert.doesNotMatch(source, /\bnetsh\b|firewall|portproxy/i)
  assert.doesNotMatch(source, /Invoke-WebRequest|Start-BitsTransfer|WebClient/i)
  assert.match(
    source,
    /Remove-Item\s+-LiteralPath\s+\$smokeRoot\s+-Recurse\s+-Force/,
  )
})
