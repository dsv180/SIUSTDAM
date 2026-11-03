@echo off
rem Copies the gateway config from this repo to the TDAM stык root.
rem The repo (agent-memory) is INSIDE C:\TDAM, git does not see one level up,
rem so the config must be copied manually after pull.
copy /Y "%~dp0..\gateway-config.yaml" "C:\TDAM\gateway-config.yaml"
if errorlevel 1 (
  echo FAILED: could not copy gateway-config.yaml to C:\TDAM\
  exit /b 1
)
echo OK: C:\TDAM\gateway-config.yaml updated. Restart the gateway to apply.
