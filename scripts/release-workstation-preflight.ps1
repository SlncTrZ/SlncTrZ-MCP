param(
  [string]$Repository = "SlncTrZ/SlncTrZ-MCP"
)

$ErrorActionPreference = "Stop"

function Invoke-Text([string]$FilePath, [string[]]$Arguments) {
  $output = & $FilePath @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed:$([Environment]::NewLine)$output"
  }
  return $output.Trim()
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "release workstation preflight must run on native Windows"
}

$root = Invoke-Text "git" @("rev-parse", "--show-toplevel")
Set-Location $root

$status = Invoke-Text "git" @("status", "--porcelain")
if (-not [string]::IsNullOrWhiteSpace($status)) {
  throw "release worktree is not clean"
}

$branch = Invoke-Text "git" @("branch", "--show-current")
if ($branch -ne "main") {
  throw "release workstation must be on main; current branch is $branch"
}

$head = Invoke-Text "git" @("rev-parse", "HEAD")
$remoteMainLine = Invoke-Text "git" @("ls-remote", "origin", "refs/heads/main")
$remoteMain = ($remoteMainLine -split "\s+")[0]
if ($head -ne $remoteMain) {
  throw "local HEAD $head does not match origin/main $remoteMain"
}

$version = Invoke-Text "node" @("-p", "require('./package.json').version")
Invoke-Text "node" @(
  "-e",
  "const [M,m]=process.versions.node.split('.').map(Number); if(M<22||M>=25||(M===22&&m<13)) process.exit(2)"
) | Out-Null

Invoke-Text "gh" @("auth", "status", "-h", "github.com") | Out-Null
$canPush = Invoke-Text "gh" @("api", "repos/$Repository", "--jq", ".permissions.push")
if ($canPush -ne "true") {
  throw "authenticated GitHub account does not report push permission for $Repository"
}

$tag = "v$version"
$notes = Join-Path $root "docs\releases\$tag.md"
if (-not (Test-Path -LiteralPath $notes -PathType Leaf)) {
  throw "release notes are missing: $notes"
}

Write-Output "WINDOWS_RELEASE_PREFLIGHT=PASS"
Write-Output "repo=$root"
Write-Output "version=$version"
Write-Output "head=$head"
Write-Output "tag=$tag"
Write-Output "release_notes=$notes"
