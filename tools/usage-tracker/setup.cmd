@echo off
setlocal enableextensions

rem ===========================================================================
rem  Remote installer for the Superpowers usage tracker (Windows / cmd.exe).
rem
rem  Downloads this tool (a clone of the frags51/superpowers fork) and installs
rem  it into the GitHub Copilot CLI: writes a self-contained hooks file so
rem  usage/subagent tracking runs WITHOUT needing the full plugin installed via
rem  /plugin, plus a headless usage-snapshot collector (no visible status line).
rem
rem  Usage:
rem    setup.cmd                       (from a local checkout, or after download)
rem
rem  NOTE: Do NOT pipe this script into cmd (e.g. `curl ... | cmd`). A batch
rem  script must be run from a FILE; piping over stdin breaks for /f, setlocal,
rem  and exit /b. Download it first, then run it:
rem
rem  Download + run in one go:
rem    PowerShell (use the call operator & to invoke the saved path):
rem      curl.exe -fsSL -o "$env:TEMP\sp-setup.cmd" ^
rem        https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.cmd
rem      ^& "$env:TEMP\sp-setup.cmd"
rem    cmd.exe:
rem      curl.exe -fsSL -o "%TEMP%\sp-setup.cmd" ^
rem        https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.cmd ^
rem        ^&^& "%TEMP%\sp-setup.cmd"
rem
rem  Environment overrides:
rem    COPILOT_HOME            Copilot config dir   (default: %USERPROFILE%\.copilot)
rem    SUPERPOWERS_USAGE_REPO  git URL to clone     (default: the frags51 fork)
rem    SUPERPOWERS_USAGE_REF   branch/tag/commit    (default: ghcp-native)
rem    SUPERPOWERS_USAGE_SRC   where to clone       (default: %COPILOT_HOME%\plugin-data\superpowers-usage\src)
rem    SUPERPOWERS_USAGE_NO_SNAPSHOT=1   install hooks only (skip AI-credit snapshots)
rem ===========================================================================

rem --- Defaults ---------------------------------------------------------------
if "%SUPERPOWERS_USAGE_REPO%"=="" ( set "REPO_URL=https://github.com/frags51/superpowers.git" ) else ( set "REPO_URL=%SUPERPOWERS_USAGE_REPO%" )
if "%SUPERPOWERS_USAGE_REF%"==""  ( set "REF=ghcp-native" ) else ( set "REF=%SUPERPOWERS_USAGE_REF%" )
if "%COPILOT_HOME%"==""           ( set "COPILOT_HOME=%USERPROFILE%\.copilot" )
if "%SUPERPOWERS_USAGE_SRC%"==""  ( set "SRC=%COPILOT_HOME%\plugin-data\superpowers-usage\src" ) else ( set "SRC=%SUPERPOWERS_USAGE_SRC%" )
set "TOOL_DIR=%SRC%\tools\usage-tracker"

rem --- Preconditions ----------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 ( echo error: missing required command: git & exit /b 1 )
where node >nul 2>nul
if errorlevel 1 ( echo error: missing required command: node & exit /b 1 )

rem Detect the Node major version. Use parseInt (no quotes) so the value is not
rem mangled inside for /f's single-quoted command wrapper.
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node,10)" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo ==^> Could not detect Node version; continuing ^(needs Node 22+ or a sqlite3 CLI^).
) else (
  if %NODE_MAJOR% LSS 22 (
    where sqlite3 >nul 2>nul
    if errorlevel 1 (
      echo error: Node %NODE_MAJOR% lacks node:sqlite and no sqlite3 CLI fallback was found.
      echo        Install Node 22+ or the sqlite3 CLI, then re-run.
      exit /b 1
    )
    echo ==^> Node %NODE_MAJOR%: will use the sqlite3 CLI fallback.
  )
)

rem --- Fetch the source -------------------------------------------------------
if exist "%SRC%\.git" (
  echo ==^> Updating existing checkout at "%SRC%"
  git -C "%SRC%" fetch --depth 1 origin "%REF%" || ( echo error: git fetch failed & exit /b 1 )
  git -C "%SRC%" checkout -q FETCH_HEAD || ( echo error: git checkout failed & exit /b 1 )
) else (
  echo ==^> Cloning %REPO_URL% ^(%REF%^) -^> "%SRC%"
  for %%I in ("%SRC%\..") do if not exist "%%~fI" mkdir "%%~fI"
  if exist "%SRC%" rmdir /s /q "%SRC%"
  git clone --depth 1 --branch "%REF%" "%REPO_URL%" "%SRC%" 2>nul
  if errorlevel 1 (
    rem REF may be a commit sha (cannot --branch a sha): clone then checkout
    git clone "%REPO_URL%" "%SRC%" || ( echo error: git clone failed & exit /b 1 )
    git -C "%SRC%" checkout -q "%REF%" || ( echo error: git checkout %REF% failed & exit /b 1 )
  )
)

if not exist "%TOOL_DIR%\install.js" (
  echo error: install.js not found at "%TOOL_DIR%" -- wrong ref or repo?
  exit /b 1
)

rem --- Verify the tool runs here ---------------------------------------------
echo ==^> Verifying the tracker runs here
node "%TOOL_DIR%\tracker.js" --selftest || ( echo error: tracker selftest failed & exit /b 1 )

rem --- Install into Copilot ---------------------------------------------------
set "INSTALL_FLAGS="
if "%SUPERPOWERS_USAGE_NO_SNAPSHOT%"=="1" set "INSTALL_FLAGS=--no-snapshot"
echo ==^> Installing into Copilot ^("%COPILOT_HOME%"^)
node "%TOOL_DIR%\install.js" %INSTALL_FLAGS% || ( echo error: install failed & exit /b 1 )

rem --- Done -------------------------------------------------------------------
echo.
echo   Superpowers usage tracker installed.
echo.
echo   source     : %TOOL_DIR%
echo   copilot    : %COPILOT_HOME%
echo   hooks file : %COPILOT_HOME%\hooks\superpowers-usage.json
echo.
echo   Next steps:
echo     1. Restart Copilot CLI so the hooks load ^(tracking is headless^).
echo     2. Open the dashboard ^(credit/time infographic + stats^):
echo          node "%TOOL_DIR%\dashboard.js"
echo     3. List active subagents any time with:
echo          node "%TOOL_DIR%\subagents.js" --all
echo     4. Uninstall with:
echo          node "%TOOL_DIR%\uninstall.js"
echo.

endlocal
exit /b 0
