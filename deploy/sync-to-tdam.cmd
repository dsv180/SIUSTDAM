@echo off
rem Deploys the gateway config + all scripts from this repo to the TDAM stык root.
rem Makes the two machines identical: this OVERWRITES local copies of the scripts.
rem If the local scripts were edited on purpose — diff first (fc /u ...).
rem Secrets are NOT here: gateway.env with keys never travels (owner rule).

copy /Y "%~dp0gateway-config.yaml" "C:\TDAM\gateway-config.yaml"
if errorlevel 1 goto :fail
xcopy /Y "%~dp0deploy\scripts\*" "C:\TDAM\"
if errorlevel 1 goto :fail
echo.
echo OK: C:\TDAM\ updated (config + scripts). Restart services to apply:
echo   gateway first (kill listener on 8420, then gateway-service.ps1), then the rest.
exit /b 0
:fail
echo FAILED: could not copy to C:\TDAM\
exit /b 1
