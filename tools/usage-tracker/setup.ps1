# Install / update the Superpowers plugin + usage tracking (Windows PowerShell).
#
# This single script INSTALLS or UPDATES, whichever is needed:
#   1. Registers the `frags51/superpowers` plugin marketplace (idempotent).
#   2. Installs the `superpowers` plugin via the Copilot CLI, or updates it if
#      it is already installed. The plugin ships the tracking hooks, skills, and
#      the usage dashboard.
#   3. Wires the one thing a plugin cannot register: the headless AI-credit
#      `statusLine` snapshot collector (points at the freshly installed plugin's
#      own snapshot.js, so `copilot plugin update` keeps it current).
#   4. Cleans up artifacts from the older standalone installer so tracking does
#      not run twice.
#
# Assumes the `copilot` and `node` commands are on PATH.
#
# One-liner (recommended on Windows) — installs OR updates:
#   irm https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/setup.ps1 | iex
#
# irm downloads the script text and iex runs it (the PowerShell equivalent of
# `curl | bash`). Works on Windows PowerShell 5.1 and PowerShell 7+.
#
# Environment overrides:
#   COPILOT_HOME            Copilot config dir   (default: %USERPROFILE%\.copilot)

function Install-Superpowers {
  $marketplaceSource = 'frags51/superpowers'
  $marketplaceName   = 'superpowers-dev'
  $pluginName        = 'superpowers'
  $pluginRef         = "$pluginName@$marketplaceName"

  function Test-HasCommand($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  if (-not (Test-HasCommand 'copilot')) { Write-Host 'error: missing required command: copilot' -ForegroundColor Red; return }
  if (-not (Test-HasCommand 'node'))    { Write-Host 'error: missing required command: node' -ForegroundColor Red; return }

  $copilotHome =
    if ($env:COPILOT_HOME)   { $env:COPILOT_HOME }
    elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.copilot' }
    else                      { Join-Path $HOME '.copilot' }

  # 1) Register the marketplace (tolerate "already registered").
  Write-Host "==> Registering marketplace $marketplaceSource"
  $mp = (& copilot plugin marketplace add $marketplaceSource 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -and $mp -notmatch 'already registered') {
    Write-Host "error: failed to add marketplace:`n$mp" -ForegroundColor Red; return
  }

  # 2) Install if missing, otherwise update.
  $installed = (& copilot plugin list 2>&1 | Out-String)
  if ($installed -match [regex]::Escape($pluginRef)) {
    Write-Host "==> Updating plugin $pluginRef"
    & copilot plugin update $pluginRef
  } else {
    Write-Host "==> Installing plugin $pluginRef"
    & copilot plugin install $pluginRef
  }
  if ($LASTEXITCODE -ne 0) { Write-Host 'error: plugin install/update failed' -ForegroundColor Red; return }

  # 3) Locate the freshly installed plugin's usage-tracker dir and wire the
  #    statusLine snapshot collector (the part a plugin manifest cannot do).
  $tool = Find-UsageTrackerDir $copilotHome $marketplaceName $pluginName
  if (-not $tool) {
    Write-Host "error: could not find the installed plugin's usage-tracker under $copilotHome\installed-plugins" -ForegroundColor Red
    return
  }
  Write-Host "==> Wiring the AI-credit snapshot statusLine"
  $env:COPILOT_HOME = $copilotHome
  & node (Join-Path $tool 'install.js') --snapshot-only
  if ($LASTEXITCODE -ne 0) { Write-Host 'error: failed to wire the statusLine' -ForegroundColor Red; return }

  # 4) Clean up artifacts from the older standalone installer: its own hooks
  #    file (the plugin now provides hooks; keeping both double-counts) and its
  #    clone directory.
  Remove-LegacyArtifacts $copilotHome

  $dash = Join-Path $tool 'dashboard.js'
  Write-Host ''
  Write-Host '  Superpowers installed/updated.' -ForegroundColor Green
  Write-Host "  plugin     : $pluginRef"
  Write-Host "  copilot    : $copilotHome"
  Write-Host "  statusLine : $(Join-Path $tool 'snapshot.js')"
  Write-Host ''
  Write-Host '  Next steps:'
  Write-Host '    1. Restart Copilot CLI so the plugin + statusLine load.'
  Write-Host '    2. Ask Copilot to "open my usage dashboard", or run it directly:'
  Write-Host "         node ""$dash"" --open"
  Write-Host '    3. Uninstall later with the uninstall.ps1 one-liner (see the README).'
}

# Find <copilotHome>/installed-plugins/<marketplace>/<plugin>/tools/usage-tracker,
# falling back to a recursive search if the marketplace folder name differs.
function Find-UsageTrackerDir($copilotHome, $marketplaceName, $pluginName) {
  $exact = Join-Path $copilotHome (Join-Path 'installed-plugins' (Join-Path $marketplaceName (Join-Path $pluginName 'tools\usage-tracker')))
  if (Test-Path (Join-Path $exact 'install.js')) { return $exact }

  $root = Join-Path $copilotHome 'installed-plugins'
  if (-not (Test-Path $root)) { return $null }
  $hit = Get-ChildItem -Path $root -Recurse -Filter 'install.js' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "[\\/]$pluginName[\\/].*usage-tracker[\\/]install\.js$" } |
    Select-Object -First 1
  if ($hit) { return $hit.DirectoryName }
  return $null
}

# Remove leftovers from the previous standalone (non-plugin) installer.
function Remove-LegacyArtifacts($copilotHome) {
  $staleHooks = Join-Path $copilotHome 'hooks\superpowers-usage.json'
  if (Test-Path $staleHooks) {
    Write-Host "==> Removing stale standalone hooks file (the plugin now provides hooks)"
    Remove-Item -Force $staleHooks -ErrorAction SilentlyContinue
  }
  $oldClone = Join-Path $copilotHome 'plugin-data\superpowers-usage\src'
  if (Test-Path $oldClone) {
    Write-Host "==> Removing old standalone clone at $oldClone"
    Remove-Item -Recurse -Force $oldClone -ErrorAction SilentlyContinue
  }
}

Install-Superpowers
