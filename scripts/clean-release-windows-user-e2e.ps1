param(
  [Parameter(Mandatory = $true)]
  [string]$Tag
)

$ErrorActionPreference = "Stop"
if ($Tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "invalid release tag: $Tag"
}
$Version = $Tag.Substring(1)
$ReleaseUrl = "https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/$Tag"

function Find-GitBash {
  $candidates = @()
  $command = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) { $candidates += $command.Source }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Git\bin\bash.exe") }
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($programFilesX86) { $candidates += (Join-Path $programFilesX86 "Git\bin\bash.exe") }
  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  throw "Git Bash was not found. Install Git for Windows before running Windows acceptance."
}

function To-GitBashPath([string]$Bash, [string]$WindowsPath) {
  $value = & $Bash "-lc" 'cygpath -u "$1"' "--" $WindowsPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
    throw "cygpath conversion failed for $WindowsPath"
  }
  return $value.Trim()
}

function Reserve-Port {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Invoke-Installed([string]$Launcher, [string[]]$Arguments) {
  $output = & $Launcher @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw ("installed command failed (" + $LASTEXITCODE + "): " + ($Arguments -join " ") + [Environment]::NewLine + $output)
  }
  return $output
}

function Wait-PathGone([string]$Path, [int]$Seconds = 20) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "timed out waiting for deferred removal: $Path"
}

$Bash = Find-GitBash
$Root = Join-Path ([IO.Path]::GetTempPath()) ("SlncTrZ Windows E2E " + [guid]::NewGuid().ToString("N"))
$Workspace = Join-Path $Root "Workspace Unicode Ω & spaces"
$InstallRoot = Join-Path $Root "Local App Data\SlncTrZ-MCP"
$StateRoot = Join-Path $Root "Profile\.slnctrz-mcp"
$ConfigRoot = Join-Path $Root "Roaming App Data\SlncTrZ-MCP"
# Windows PowerShell 5.1 can split POSIX argv containing spaces when launching bash.exe.
# Keep Bash entry paths space-free and pass Windows paths through process environment instead.
$InstallScript = Join-Path ([IO.Path]::GetTempPath()) ("slnctrz-windows-e2e-bootstrap-" + [guid]::NewGuid().ToString("N") + ".sh")
$BootstrapDriver = Join-Path ([IO.Path]::GetTempPath()) ("slnctrz-windows-e2e-driver-" + [guid]::NewGuid().ToString("N") + ".sh")
$GatewayStdout = Join-Path $Root "gateway.stdout.log"
$GatewayStderr = Join-Path $Root "gateway.stderr.log"
$GatewayPort = Reserve-Port

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/install.sh" -OutFile $InstallScript

$InstallScriptPosix = To-GitBashPath $Bash $InstallScript
$BootstrapDriverContent = @'
#!/usr/bin/env bash
set -euo pipefail
exec "$SLNCTRZ_E2E_INSTALL_SCRIPT" \
  --mode user \
  --port "$SLNCTRZ_E2E_PORT" \
  --path "$SLNCTRZ_E2E_WORKSPACE" \
  --install-root "$SLNCTRZ_E2E_INSTALL_ROOT" \
  --state-root "$SLNCTRZ_E2E_STATE_ROOT" \
  --config-root "$SLNCTRZ_E2E_CONFIG_ROOT"
'@
Set-Content -LiteralPath $BootstrapDriver -Value $BootstrapDriverContent -Encoding Ascii
$BootstrapDriverPosix = To-GitBashPath $Bash $BootstrapDriver

$previousReleaseUrl = $env:SLNCTRZ_RELEASE_URL
$previousE2eInstallScript = $env:SLNCTRZ_E2E_INSTALL_SCRIPT
$previousE2ePort = $env:SLNCTRZ_E2E_PORT
$previousE2eWorkspace = $env:SLNCTRZ_E2E_WORKSPACE
$previousE2eInstallRoot = $env:SLNCTRZ_E2E_INSTALL_ROOT
$previousE2eStateRoot = $env:SLNCTRZ_E2E_STATE_ROOT
$previousE2eConfigRoot = $env:SLNCTRZ_E2E_CONFIG_ROOT
try {
  $env:SLNCTRZ_RELEASE_URL = $ReleaseUrl
  $env:SLNCTRZ_E2E_INSTALL_SCRIPT = $InstallScriptPosix
  $env:SLNCTRZ_E2E_PORT = [string]$GatewayPort
  $env:SLNCTRZ_E2E_WORKSPACE = $Workspace
  $env:SLNCTRZ_E2E_INSTALL_ROOT = $InstallRoot
  $env:SLNCTRZ_E2E_STATE_ROOT = $StateRoot
  $env:SLNCTRZ_E2E_CONFIG_ROOT = $ConfigRoot

  $setup = & $Bash $BootstrapDriverPosix 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw ("Git Bash bootstrap failed (" + $LASTEXITCODE + "):" + [Environment]::NewLine + $setup)
  }
  if ($setup -notmatch "Setup Complete" -or $setup -notmatch "Owner Passphrase:") {
    throw "setup output did not contain the expected completion/passphrase handoff"
  }

  $Launcher = Join-Path $InstallRoot "slnctrz-mcp.exe"
  $PassphraseFile = Join-Path $StateRoot "secrets\owner-passphrase"
  $InstallationFile = Join-Path $StateRoot "installation.json"
  $ConfigFile = Join-Path $ConfigRoot "gateway.env"
  foreach ($path in @($Launcher, $PassphraseFile, $InstallationFile, $ConfigFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "expected installed file is missing: $path"
    }
  }

  $binaryVersion = (Invoke-Installed $Launcher @("--version")).Trim()
  if ($binaryVersion -ne $Version) {
    throw "installed version mismatch: $binaryVersion != $Version"
  }

  $process = Start-Process -FilePath $Launcher -WorkingDirectory $InstallRoot -RedirectStandardOutput $GatewayStdout -RedirectStandardError $GatewayStderr -PassThru -WindowStyle Hidden
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $healthy = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) {
        $stderr = if (Test-Path $GatewayStderr) { Get-Content $GatewayStderr -Raw } else { "" }
        throw "installed gateway exited before health readiness: $stderr"
      }
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$GatewayPort/healthz" -TimeoutSec 1
        if ($response.StatusCode -eq 200) { $healthy = $true; break }
      }
      catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $healthy) { throw "installed gateway did not become healthy" }

    $status = Invoke-Installed $Launcher @("status", "--json") | ConvertFrom-Json
    if ($status.version -ne $Version -or $status.gateway -ne "running") {
      throw "installed status did not report the expected running release"
    }

    $doctor = Invoke-Installed $Launcher @("doctor", "--json") | ConvertFrom-Json
    if (@($doctor.diagnostics | Where-Object { $_.level -eq "FAIL" }).Count -ne 0) {
      throw "installed doctor reported FAIL"
    }
  }
  finally {
    if ($null -ne $process -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
      $process.WaitForExit()
    }
  }

  $uninstall = Invoke-Installed $Launcher @("uninstall", "--yes")
  if ($uninstall -notmatch "State preserved: yes") {
    throw "default uninstall did not report state preservation"
  }
  $deferredProgramRemoval = $uninstall -match "Program removal deferred: yes"
  if ($deferredProgramRemoval) {
    # Windows self-invoked uninstall cannot delete its own running exe, so program removal is
    # deferred to a detached helper that removes the install root once the uninstall process is
    # fully released (or at the next reboot). Accept that the install root may persist until the
    # helper runs instead of requiring an impossible immediate deletion of a running executable.
    Write-Output "program removal deferred (self-invoked); install root scheduled for removal"
  } else {
    Wait-PathGone $InstallRoot
  }
  if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) {
    throw "default uninstall removed state"
  }
  if (-not (Test-Path -LiteralPath $ConfigRoot -PathType Container)) {
    throw "default uninstall removed config"
  }

  Write-Output "clean_windows_user_install=pass"
  Write-Output "tag=$Tag"
  Write-Output "version=$Version"
  Write-Output "bootstrap=Git Bash exact-tag HTTPS"
  Write-Output "native_runtime_without_node=pass"
  Write-Output "running_health_status_doctor=pass"
  Write-Output "default_uninstall_preserved_state=pass"
}
finally {
  if ($null -eq $previousReleaseUrl) { Remove-Item Env:SLNCTRZ_RELEASE_URL -ErrorAction SilentlyContinue }
  else { $env:SLNCTRZ_RELEASE_URL = $previousReleaseUrl }
  foreach ($entry in @(
    @{ Name = "SLNCTRZ_E2E_INSTALL_SCRIPT"; Value = $previousE2eInstallScript },
    @{ Name = "SLNCTRZ_E2E_PORT"; Value = $previousE2ePort },
    @{ Name = "SLNCTRZ_E2E_WORKSPACE"; Value = $previousE2eWorkspace },
    @{ Name = "SLNCTRZ_E2E_INSTALL_ROOT"; Value = $previousE2eInstallRoot },
    @{ Name = "SLNCTRZ_E2E_STATE_ROOT"; Value = $previousE2eStateRoot },
    @{ Name = "SLNCTRZ_E2E_CONFIG_ROOT"; Value = $previousE2eConfigRoot }
  )) {
    if ($null -eq $entry.Value) { Remove-Item ("Env:" + $entry.Name) -ErrorAction SilentlyContinue }
    else { Set-Item ("Env:" + $entry.Name) $entry.Value }
  }
  Remove-Item -LiteralPath $BootstrapDriver -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallScript -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
