# TDAM memory web viewer launcher (autostart via Startup shortcut).
# ASCII-only on purpose. Safe to run repeatedly: exits if port 8901 is in use.

$ErrorActionPreference = 'Stop'
$root = 'C:\TDAM'
$log  = Join-Path $root 'memory-web-service.log'

try {
    # load env from gateway.env (gateway API key for Bearer)
    Get-Content (Join-Path $root 'gateway.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }

    $listening = Get-NetTCPConnection -LocalPort 8901 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Add-Content $log "[$(Get-Date -Format s)] port 8901 already in use - skip"; exit 0 }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Start-Process -FilePath (Join-Path $root 'node.exe') `
        -ArgumentList 'C:\TDAM\memory-web.mjs' `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root "memory-web-out-$stamp.log") `
        -RedirectStandardError (Join-Path $root "memory-web-err-$stamp.log")

    Add-Content $log "[$(Get-Date -Format s)] memory web spawned (detached) on :8901"
    exit 0
}
catch {
    Add-Content $log "[$(Get-Date -Format s)] launcher error: $_"
    exit 1
}
