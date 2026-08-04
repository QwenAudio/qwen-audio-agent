param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExecutablePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedExecutable = Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop
$executable = Get-Item -LiteralPath $resolvedExecutable.Path -ErrorAction Stop
if ($executable.PSIsContainer -or $executable.Extension -ne '.exe') {
  throw 'ExecutablePath must identify one Windows .exe file.'
}

$process = $null
$windowReady = $false
$smokeRoot = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  ("qwen-audio-agent-smoke-{0}" -f [System.Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $smokeRoot

try {
  $userDataArgument = '--user-data-dir="{0}"' -f $smokeRoot
  $process = Start-Process `
    -FilePath $resolvedExecutable.Path `
    -ArgumentList @($userDataArgument) `
    -PassThru
  $deadline = [System.DateTime]::UtcNow.AddSeconds(30)

  do {
    if ($process.HasExited) {
      throw "Desktop process exited before opening a window (code $($process.ExitCode))."
    }
    $current = Get-Process -Id $process.Id -ErrorAction Stop
    $current.Refresh()
    if ($current.MainWindowHandle -ne [System.IntPtr]::Zero) {
      $windowReady = $true
      Write-Output "WINDOW_READY PID=$($process.Id) HANDLE=$($current.MainWindowHandle)"
      break
    }
    Start-Sleep -Milliseconds 250
  } while ([System.DateTime]::UtcNow -lt $deadline)

  if (-not $windowReady) {
    throw 'Desktop process did not expose a top-level window within 30 seconds.'
  }
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -ErrorAction Stop
    $null = $process.WaitForExit(5000)
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
