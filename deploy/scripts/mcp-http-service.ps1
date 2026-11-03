# TDAM MCP-over-HTTP service launcher (autostart via Startup shortcut).
# ASCII-only on purpose. Safe to run repeatedly: exits if port 8900 is in use.
# Start-Process detaches node from this script.

$ErrorActionPreference = 'Stop'
$root = 'C:\TDAM'
$log  = Join-Path $root 'mcp-http-service.log'

try {
    $listening = Get-NetTCPConnection -LocalPort 8900 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Add-Content $log "[$(Get-Date -Format s)] port 8900 already in use - skip"; exit 0 }

    Get-Content (Join-Path $root 'gateway.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Start-Process -FilePath (Join-Path $root 'node.exe') `
        -ArgumentList 'C:\TDAM\mcp-http.mjs' `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root "mcp-http-out-$stamp.log") `
        -RedirectStandardError (Join-Path $root "mcp-http-err-$stamp.log")

    Add-Content $log "[$(Get-Date -Format s)] mcp-http spawned (detached) on :8900"
    exit 0
}
catch {
    Add-Content $log "[$(Get-Date -Format s)] launcher error: $_"
    exit 1
}
