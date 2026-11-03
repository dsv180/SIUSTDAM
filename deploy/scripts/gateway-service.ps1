# TDAM gateway service launcher (autostart via Startup shortcut).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# Safe to run repeatedly: exits if port 8420 is already listening.
# Start-Process detaches node from this script: the gateway outlives it.

$ErrorActionPreference = 'Stop'
$root = 'C:\TDAM'
$core = Join-Path $root 'agent-memory\MemoryCore'
$log  = Join-Path $root 'gateway-service.log'

try {
    $listening = Get-NetTCPConnection -LocalPort 8420 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Add-Content $log "[$(Get-Date -Format s)] port 8420 already in use - skip"; exit 0 }

    # load env from gateway.env (LLM key, reasoning switch)
    Get-Content (Join-Path $root 'gateway.env') | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
    $env:TDAI_GATEWAY_CONFIG = Join-Path $root 'gateway-config.yaml'

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Start-Process -FilePath 'node' `
        -ArgumentList '--import', 'tsx', 'src\gateway\server.ts' `
        -WorkingDirectory $core `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root "gateway-out-$stamp.log") `
        -RedirectStandardError (Join-Path $root "gateway-err-$stamp.log")

    Add-Content $log "[$(Get-Date -Format s)] gateway spawned (detached), out=gateway-out-$stamp.log"
    exit 0
}
catch {
    Add-Content $log "[$(Get-Date -Format s)] launcher error: $_"
    exit 1
}
