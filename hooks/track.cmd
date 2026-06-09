: << 'CMDBLOCK'
@echo off
REM Cross-platform wrapper: runs the usage tracker with an event name.
REM Usage: track.cmd <event>
if "%~1"=="" exit /b 0
set "HOOK_DIR=%~dp0"
set "TRACKER=%HOOK_DIR%..\tools\usage-tracker\tracker.js"
where node >nul 2>nul
if %ERRORLEVEL% equ 0 ( node "%TRACKER%" %1 >nul 2>nul & exit /b 0 )
exit /b 0
CMDBLOCK

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Fail-open: a usage-tracking hook must never block the user's tool, so always
# exit 0 regardless of node's result (don't 'exec', and swallow output/errors).
node "${SCRIPT_DIR}/../tools/usage-tracker/tracker.js" "$1" >/dev/null 2>&1
exit 0
