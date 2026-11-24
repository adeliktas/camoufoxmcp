#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Control the persistent camofox-browser REST server (PowerShell version).

.DESCRIPTION
    Equivalent of local/camofox-ctl for Windows. Manages the camofox-browser
    Node.js server process: start, stop, restart, status, ensure (start if
    not running), view logs, print URL.

    The server (node server.js) owns the ONE Camoufox browser. The MCP proxy
    that AI agents spawn is stateless and never launches a browser. So: one
    server, one browser window, tabs and cookies survive agent reloads and
    machine reboots.

.NOTES
    Source the env file first (or run from the repo root where .env exists).
    Usage: .\camofox-ctl.ps1 {start|stop|restart|status|ensure|logs|url|open}
#>

param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'ensure', 'logs', 'url', 'open')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$ScriptRoot = Split-Path -Parent $PSCommandPath
# repo = parent of local/
$RepoRoot = Split-Path -Parent $ScriptRoot
$EnvFile = Join-Path $ScriptRoot 'camofox.env'

# --- Load env (source-like behavior in PowerShell) ---
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -notmatch '^[#;]' -and $_ -notmatch '^\s*$' } | ForEach-Object {
        if ($_ -match '^\s*:\s*"?\${(\w+)(?::=)(.*?)"?\};"?\s*;\s*export\s+(.+)$') {
            $var = $matches[1]
            $val = $matches[2]
            $export = $matches[3]
            if (-not (Test-Path "env:$var")) {
                [Environment]::SetEnvironmentVariable($var, $val, 'Process')
            }
            if ($export) { [Environment]::SetEnvironmentVariable($export, $val, 'Process') }
        }
        elseif ($_ -match '^(\w+)\s*=\s*(.+)$') {
            $var = $matches[1]
            $val = $matches[2].Trim('"', "'")
            [Environment]::SetEnvironmentVariable($var, $val, 'Process')
        }
    }
}

$Host = $env:CAMOFOX_BIND_HOST ?? '127.0.0.1'
$Port = [int]($env:CAMOFOX_PORT ?? 9377)
$StateDir = $env:CAMOFOX_STATE_DIR ?? "$env:USERPROFILE\.local\share\camofox-browser"
$PidFile  = Join-Path $StateDir 'server.pid'
$LogFile  = Join-Path $StateDir 'server.log'

# Ensure state directory exists
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }

function Get-Url() { "http://$Host`:$Port" }

function Get-Pid() {
    if (Test-Path $PidFile) {
        try { [int](Get-Content $PidFile -Raw) } catch { $null }
    } else { $null }
}

function Test-Healthy() {
    try {
        $resp = Invoke-WebRequest -Uri "$(Get-Url)/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch { return $false }
}

function Test-PortOpen() {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $result = $tcp.BeginConnect($Host, $Port, $null, $null)
        $null = $tcp.EndConnect($result)
        $tcp.Close()
        return $true
    } catch { return $false }
}

function Get-Servers() {
    Get-Process -Name 'node' -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'server\.js' } |
        Select-Object -ExpandProperty Id
}

function Start-Server() {
    if (Test-Healthy) {
        $pid = Get-Pid
        if ($pid) { Write-Host "already running: pid $pid $(Get-Url)" }
        else { Write-Host "already running (no pidfile): $(Get-Url)" }
        return
    }

    # Port taken by something that is not ours: never race it.
    if (Test-PortOpen) {
        Write-Error "error: $Host`:$Port is open but is not a healthy camofox-browser."
        Write-Error "       refusing to start a second server. Check: netstat -ano | findstr :$Port"
        return
    }

    # Start the server
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = Join-Path $RepoRoot 'server.js'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot

    $proc = [System.Diagnostics.Process]::Start($psi)
    $procId = $proc.Id

    # Also try the node.exe path directly (fallback)
    if ($procId -eq 0 -or -not $proc.Id) {
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if ($nodeExe) {
            $psi2 = New-Object System.Diagnostics.ProcessStartInfo
            $psi2.FileName = $nodeExe
            $psi2.Arguments = Join-Path $RepoRoot 'server.js'
            $psi2.RedirectStandardOutput = $true
            $psi2.RedirectStandardError = $true
            $psi2.UseShellExecute = $false
            $psi2.CreateNoWindow = $true
            $psi2.WorkingDirectory = $RepoRoot
            $proc2 = [System.Diagnostics.Process]::Start($psi2)
            if ($proc2.Id -ne 0) { $procId = $proc2.Id }
        }
    }

    if ($procId -eq 0) {
        Write-Error "failed to start camofox-browser server"
        return
    }

    "$procId" | Set-Content $PidFile -Encoding UTF8

    # Wait for healthy
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Healthy) {
            Write-Host "started: pid $procId $(Get-Url)"
            return
        }
    }
    Write-Warning "server not healthy after 60s — check $LogFile"
}

function Stop-Server() {
    $pid = Get-Pid
    if (-not $pid) {
        # Try finding by process name
        $pids = Get-Servers
        if ($pids) {
            foreach ($p in $pids) { Stop-Process -Id $p -Force }
            Write-Host "stopped $($pids.Count) node server(s)"
        } else {
            Write-Host "not running (no pid found)"
        }
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        return
    }

    try {
        $proc = [System.Diagnostics.Process]::GetById($pid)
        $proc.CloseMainWindow()
        $null = $proc.WaitForExit(5000)
        if (-not $proc.HasExited) { $proc.Kill(); $null = $proc.WaitForExit() }
    } catch { /* already gone */ }

    Write-Host "stopped: pid $pid"
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Status() {
    if (Test-Healthy) {
        $pid = Get-Pid
        $mode = if ($env:CAMOFOX_INTERACTIVE -eq 'desktop') { 'headed' } else { 'headless' }
        Write-Host "running: pid $(if($pid){$pid}['unknown']) mode=$mode $(Get-Url)"
    } else {
        Write-Host "not running (or unhealthy)"
    }
}

function Ensure() {
    Status
    if (-not (Test-Healthy)) {
        Start-Server
    }
}

function Logs() {
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail 30 -Wait
    } else {
        Write-Host "no log file at $LogFile"
    }
}

function Open-Browser() {
    Start-Process (Get-Url)
}

# --- Dispatch ---
switch ($Command) {
    'start'    { Start-Server }
    'stop'     { Stop-Server }
    'restart'  { Stop-Server; Start-Sleep -Seconds 2; Start-Server }
    'status'   { Status }
    'ensure'   { Ensure }
    'logs'     { Logs }
    'url'      { Get-Url }
    'open'     { Open-Browser }
}
