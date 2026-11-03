# TDAM Panel launcher (backend :8123 + frontend :5173). ASCII-only.
$ErrorActionPreference = 'Stop'
$root = 'C:\TDAM'
$panel = 'C:\TDAM\agent-memory\MemoryPanel'
$log = Join-Path $root 'panel-service.log'
try {
    # load env from gateway.env (gateway API key: vite proxy injects Bearer)
    Get-Content (Join-Path $root 'gateway.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }

    $b = Get-NetTCPConnection -LocalPort 8123 -State Listen -ErrorAction SilentlyContinue
    $f = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if ($b -and $f) { Add-Content $log "[$(Get-Date -Format s)] both up - skip"; exit 0 }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (-not $b) {
        Start-Process -FilePath (Join-Path $root 'node.exe') -ArgumentList '--import','tsx','src/index.ts' -WorkingDirectory $panel -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "panel-out-$stamp.log") -RedirectStandardError (Join-Path $root "panel-err-$stamp.log")
        Add-Content $log "[$(Get-Date -Format s)] panel backend spawned"
    }
    if (-not $f) {
        Start-Sleep -Seconds 3
        Start-Process -FilePath (Join-Path $root 'node.exe') -ArgumentList 'node_modules/vite/bin/vite.js' -WorkingDirectory (Join-Path $panel 'web') -WindowStyle Hidden
        Add-Content $log "[$(Get-Date -Format s)] panel frontend spawned"
    }
    exit 0
} catch { Add-Content $log "[$(Get-Date -Format s)] launcher error: $_"; exit 1 }
