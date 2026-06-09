# Uninstall the Superpowers plugin + usage tracking (Windows PowerShell).
#
# Reverses what setup.ps1 did, in the safe order:
#   1. Strips the AI-credit `statusLine` snapshot collector (and any stale
#      standalone hooks file) by running the plugin's own uninstall.js WHILE the
#      plugin is still on disk.
#   2. Uninstalls the `superpowers` plugin via the Copilot CLI.
#   3. Removes the `frags51/superpowers` marketplace registration.
#   4. Cleans up any leftover standalone clone directory.
#
# Assumes the `copilot` and `node` commands are on PATH.
#
# One-liner (Windows):
#   irm https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/uninstall.ps1 | iex
#
# Environment overrides:
#   COPILOT_HOME            Copilot config dir   (default: %USERPROFILE%\.copilot)

function Uninstall-Superpowers {
  $marketplaceName = 'superpowers-dev'
  $pluginName      = 'superpowers'
  $pluginRef       = "$pluginName@$marketplaceName"

  function Test-HasCommand($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  if (-not (Test-HasCommand 'copilot')) { Write-Host 'error: missing required command: copilot' -ForegroundColor Red; return }

  $copilotHome =
    if ($env:COPILOT_HOME)   { $env:COPILOT_HOME }
    elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.copilot' }
    else                      { Join-Path $HOME '.copilot' }

  # 1) Strip the statusLine + standalone hooks via the plugin's uninstall.js
  #    (must run before the plugin files are removed). Requires node.
  $tool = Find-UsageTrackerDir $copilotHome $marketplaceName $pluginName
  if ($tool -and (Test-HasCommand 'node')) {
    Write-Host "==> Removing the AI-credit snapshot statusLine"
    $env:COPILOT_HOME = $copilotHome
    & node (Join-Path $tool 'uninstall.js')
  } else {
    Write-Host "==> Plugin usage-tracker not found (or node missing); removing statusLine directly"
    Remove-StatusLine $copilotHome
  }

  # 2) Uninstall the plugin (tolerate "not installed").
  Write-Host "==> Uninstalling plugin $pluginRef"
  $out = (& copilot plugin uninstall $pluginRef 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -and $out -notmatch 'not installed|not found') {
    Write-Host $out -ForegroundColor Yellow
  }

  # 3) Remove the marketplace registration (tolerate "not found").
  Write-Host "==> Removing marketplace $marketplaceName"
  $out = (& copilot plugin marketplace remove $marketplaceName 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -and $out -notmatch 'not found|not registered') {
    Write-Host $out -ForegroundColor Yellow
  }

  # 4) Clean up any leftover standalone clone directory.
  $oldClone = Join-Path $copilotHome 'plugin-data\superpowers-usage\src'
  if (Test-Path $oldClone) {
    Write-Host "==> Removing old standalone clone at $oldClone"
    Remove-Item -Recurse -Force $oldClone -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host '  Superpowers uninstalled. Restart Copilot CLI so the changes take effect.' -ForegroundColor Green
  Write-Host "  Note: usage history in $(Join-Path $copilotHome 'plugin-data\superpowers-usage\usage.db') was left in place."
}

# Find <copilotHome>/installed-plugins/<marketplace>/<plugin>/tools/usage-tracker,
# falling back to a recursive search if the marketplace folder name differs.
function Find-UsageTrackerDir($copilotHome, $marketplaceName, $pluginName) {
  $exact = Join-Path $copilotHome (Join-Path 'installed-plugins' (Join-Path $marketplaceName (Join-Path $pluginName 'tools\usage-tracker')))
  if (Test-Path (Join-Path $exact 'uninstall.js')) { return $exact }

  $root = Join-Path $copilotHome 'installed-plugins'
  if (-not (Test-Path $root)) { return $null }
  $hit = Get-ChildItem -Path $root -Recurse -Filter 'uninstall.js' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "[\\/]$pluginName[\\/].*usage-tracker[\\/]uninstall\.js$" } |
    Select-Object -First 1
  if ($hit) { return $hit.DirectoryName }
  return $null
}

# Fallback: strip the statusLine straight from settings.json without node.
function Remove-StatusLine($copilotHome) {
  $settingsPath = Join-Path $copilotHome 'settings.json'
  if (-not (Test-Path $settingsPath)) { return }
  try {
    $json = Get-Content -Raw $settingsPath | ConvertFrom-Json
    if ($json.PSObject.Properties.Name -contains 'statusLine') {
      $json.PSObject.Properties.Remove('statusLine')
      ($json | ConvertTo-Json -Depth 50) | Set-Content -Path $settingsPath -Encoding UTF8
    }
  } catch {
    Write-Host "warning: could not edit settings.json automatically: $_" -ForegroundColor Yellow
  }
  $staleHooks = Join-Path $copilotHome 'hooks\superpowers-usage.json'
  if (Test-Path $staleHooks) { Remove-Item -Force $staleHooks -ErrorAction SilentlyContinue }
}

Uninstall-Superpowers
