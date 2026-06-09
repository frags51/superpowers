# Remote installer for the Superpowers usage tracker (Windows PowerShell).
#
# Installs the tracker into the GitHub Copilot CLI: a self-contained hooks file
# plus a headless AI-credit snapshot collector. Works on Windows PowerShell 5.1
# and PowerShell 7+.
#
# One-liner (recommended on Windows):
#   irm https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.ps1 | iex
#
# This is the PowerShell equivalent of `curl | bash`: irm downloads the script
# text and iex runs it. (Do NOT `curl … | cmd` a .cmd file — batch scripts must
# run from a file, and piping causes curl write errors.)
#
# Environment overrides:
#   COPILOT_HOME                     Copilot config dir  (default: %USERPROFILE%\.copilot)
#   SUPERPOWERS_USAGE_REPO           git URL to clone    (default: the frags51 fork)
#   SUPERPOWERS_USAGE_REF            branch/tag/commit   (default: ghcp-native)
#   SUPERPOWERS_USAGE_SRC            where to clone      (default: <COPILOT_HOME>\plugin-data\superpowers-usage\src)
#   SUPERPOWERS_USAGE_NO_SNAPSHOT=1  install hooks only (skip AI-credit snapshots)

function Install-SuperpowersUsage {
  $repo = if ($env:SUPERPOWERS_USAGE_REPO) { $env:SUPERPOWERS_USAGE_REPO } else { 'https://github.com/frags51/superpowers.git' }
  $ref  = if ($env:SUPERPOWERS_USAGE_REF)  { $env:SUPERPOWERS_USAGE_REF }  else { 'ghcp-native' }
  $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
  $src  = if ($env:SUPERPOWERS_USAGE_SRC) { $env:SUPERPOWERS_USAGE_SRC } else { Join-Path $copilotHome 'plugin-data\superpowers-usage\src' }
  $tool = Join-Path $src 'tools\usage-tracker'

  function Test-HasCommand($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  if (-not (Test-HasCommand 'git'))  { Write-Host 'error: missing required command: git' -ForegroundColor Red; return }
  if (-not (Test-HasCommand 'node')) { Write-Host 'error: missing required command: node' -ForegroundColor Red; return }

  # Detect the Node major version (parseInt avoids quoting issues).
  $nodeMajor = 0
  try { $nodeMajor = [int](& node -p 'parseInt(process.versions.node,10)') } catch { $nodeMajor = 0 }
  if ($nodeMajor -gt 0 -and $nodeMajor -lt 22 -and -not (Test-HasCommand 'sqlite3')) {
    Write-Host "error: Node $nodeMajor lacks node:sqlite and no sqlite3 CLI fallback was found." -ForegroundColor Red
    Write-Host '       Install Node 22+ or the sqlite3 CLI, then re-run.' -ForegroundColor Red
    return
  }
  if ($nodeMajor -gt 0 -and $nodeMajor -lt 22) {
    Write-Host "==> Node ${nodeMajor}: will use the sqlite3 CLI fallback."
  }

  # Fetch the source.
  if (Test-Path (Join-Path $src '.git')) {
    Write-Host "==> Updating existing checkout at $src"
    & git -C $src fetch --depth 1 origin $ref
    & git -C $src checkout -q FETCH_HEAD
  } else {
    Write-Host "==> Cloning $repo ($ref) -> $src"
    $parent = Split-Path $src -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (Test-Path $src) { Remove-Item -Recurse -Force $src }
    & git clone --depth 1 --branch $ref $repo $src
    if ($LASTEXITCODE -ne 0) {
      # $ref may be a commit sha (cannot --branch a sha): clone then checkout.
      & git clone $repo $src
      & git -C $src checkout -q $ref
    }
  }

  if (-not (Test-Path (Join-Path $tool 'install.js'))) {
    Write-Host "error: install.js not found at $tool -- wrong ref or repo?" -ForegroundColor Red
    return
  }

  Write-Host '==> Verifying the tracker runs here'
  & node (Join-Path $tool 'tracker.js') --selftest
  if ($LASTEXITCODE -ne 0) { Write-Host 'error: tracker selftest failed' -ForegroundColor Red; return }

  $flags = @()
  if ($env:SUPERPOWERS_USAGE_NO_SNAPSHOT -eq '1') { $flags += '--no-snapshot' }
  Write-Host "==> Installing into Copilot ($copilotHome)"
  $env:COPILOT_HOME = $copilotHome
  & node (Join-Path $tool 'install.js') @flags
  if ($LASTEXITCODE -ne 0) { Write-Host 'error: install failed' -ForegroundColor Red; return }

  $dash = Join-Path $tool 'dashboard.js'
  $unin = Join-Path $tool 'uninstall.js'
  Write-Host ''
  Write-Host '  Superpowers usage tracker installed.' -ForegroundColor Green
  Write-Host "  source     : $tool"
  Write-Host "  copilot    : $copilotHome"
  Write-Host "  hooks file : $(Join-Path $copilotHome 'hooks\superpowers-usage.json')"
  Write-Host ''
  Write-Host '  Next steps:'
  Write-Host '    1. Restart Copilot CLI so the hooks load (tracking is headless).'
  Write-Host "    2. Open the dashboard:  node ""$dash"" --open"
  Write-Host "    3. Uninstall:           node ""$unin"""
}

Install-SuperpowersUsage
