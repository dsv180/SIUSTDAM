@echo off
setlocal
rem Deploys the scripts (and, on first run, the gateway config) from this repo
rem to the TDAM junction root C:\TDAM.
rem
rem Scripts are ALWAYS overwritten: the goal is to make the machines identical.
rem The gateway config is copied ONLY when C:\TDAM\gateway-config.yaml is absent,
rem or when called with --force-config. Reason: the live config on a machine may
rem deliberately differ from the repo variant (e.g. dsv keeps Ollama bge-m3
rem 1024d + host 127.0.0.1, while the repo variant is text-embedding-3-small
rem 1536d + host 0.0.0.0 for the second machine). Overwriting it silently would
rem break search over already-stored vectors.
rem Secrets are NOT here: gateway.env with keys never travels (owner rule).
rem
rem Usage:
rem   sync-to-tdam.cmd                 - update scripts; copy config only if missing
rem   sync-to-tdam.cmd --force-config  - also overwrite the config with the repo variant

set "REPO=%~dp0"
set "STYK=C:\TDAM"

if not exist "%STYK%\" (
  echo FAILED: %STYK%\ does not exist. Create the junction first:
  echo   mklink /J C:\TDAM\agent-memory ^<path-to-repo^>
  exit /b 1
)

rem --- gateway config: guard against silently clobbering a local variant ---
if /i "%~1"=="--force-config" goto :copy_config
if exist "%STYK%\gateway-config.yaml" (
  echo SKIP: %STYK%\gateway-config.yaml already exists - left as is.
  echo       Use: sync-to-tdam.cmd --force-config   to overwrite it with the repo variant.
  goto :copy_scripts
)

:copy_config
if not exist "%REPO%gateway-config.yaml" (
  echo FAILED: %REPO%gateway-config.yaml not found (expected in the repo root).
  exit /b 1
)
copy /Y "%REPO%gateway-config.yaml" "%STYK%\gateway-config.yaml"
if errorlevel 1 goto :fail
echo OK: gateway-config.yaml copied.

:copy_scripts
if not exist "%REPO%deploy\scripts\" (
  echo FAILED: %REPO%deploy\scripts\ not found.
  exit /b 1
)
xcopy /Y "%REPO%deploy\scripts\*" "%STYK%\"
if errorlevel 1 goto :fail

echo.
echo OK: %STYK%\ updated (scripts; config per the rule above). Restart services to apply:
echo   gateway first (kill listener on 8420, then gateway-service.ps1), then the rest
echo   (mcp-http-service.ps1 on 8900, memory-web-service.ps1 on 8901, panel-service.ps1).
exit /b 0

:fail
echo FAILED: could not copy to %STYK%\
exit /b 1
