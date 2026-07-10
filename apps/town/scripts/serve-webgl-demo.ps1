# Serve AgentTown WebGL build and open Offline Demo (?demo=1) — no backend / LLM required.
#
#   pnpm town:serve:webgl
#   powershell -File apps/town/scripts/serve-webgl-demo.ps1
#   powershell -File apps/town/scripts/serve-webgl-demo.ps1 -Port 4173 -NoBrowser
#
# Prefers :8080 (CORS-listed); falls back to :4173 when busy (same as spike-webgl-sse.ps1).

[CmdletBinding()]
param(
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [int]$Port = 8080,
    [string]$Pack = 'price_surge',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-WarnStep([string]$msg) { Write-Host "! $msg" -ForegroundColor Yellow }

function Test-PortListening([int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(200)
        if ($ok -and $c.Connected) { $c.EndConnect($iar); $c.Close(); return $true }
        $c.Close()
    } catch { }
    return $false
}

function Test-WebGlHost([int]$p) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -UseBasicParsing -TimeoutSec 2
        return ($r.Content -match 'UnityLoader|createUnityInstance|unity-canvas|Build/')
    } catch {
        return $false
    }
}

$webglDir = Join-Path $ProjectPath 'Builds\WebGL'
$webglIndex = Join-Path $webglDir 'index.html'
if (-not (Test-Path $webglIndex)) {
    throw "WebGL build missing: $webglIndex`nRun: pnpm town:build:webgl"
}

$candidates = @($Port, 4173, 8080) | Select-Object -Unique
$resolved = $null
foreach ($p in $candidates) {
    if (-not (Test-PortListening $p)) {
        $resolved = $p
        break
    }
    if (Test-WebGlHost $p) {
        $resolved = $p
        Write-Ok "Reusing existing WebGL host on :$p"
        break
    }
    Write-WarnStep "Port $p busy (non-WebGL) — trying next"
}

if ($null -eq $resolved) {
    throw "No free CORS-friendly port among $($candidates -join ', ')"
}

$packId = if ([string]::IsNullOrWhiteSpace($Pack)) { 'price_surge' } else { $Pack.Trim().ToLowerInvariant() }
$demoUrl = "http://127.0.0.1:${resolved}/?demo=1&pack=$packId"
$packHint = "http://127.0.0.1:${resolved}/?demo=1&pack=festival  (or town_hall; default price_surge)"
$liveHint = "http://127.0.0.1:${resolved}/?api=http%3A%2F%2Flocalhost%3A8000&token=TOKEN&run=RUN_ID"

Write-Host ''
Write-Host '=== AgentTown WebGL Offline Demo ===' -ForegroundColor Magenta
Write-Host $demoUrl
Write-Host "Packs: $packHint" -ForegroundColor DarkGray
Write-Host "Live (needs backend): $liveHint" -ForegroundColor DarkGray
Write-Host ''

$serveProc = $null
$startedServe = $false
try {
    $reuse = (Test-PortListening $resolved) -and (Test-WebGlHost $resolved)
    if (-not $reuse) {
        Write-Step "Serve Builds/WebGL on http://127.0.0.1:$resolved"
        $npxCmd = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { 'npx.cmd' } else { 'npx' }
        $logDir = Join-Path $ProjectPath 'logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $serveOut = Join-Path $logDir 'serve-webgl-demo.out.log'
        $serveErr = Join-Path $logDir 'serve-webgl-demo.err.log'
        $serveProc = Start-Process -FilePath $npxCmd `
            -ArgumentList @('--yes', 'serve', '-l', "tcp://127.0.0.1:$resolved", '.') `
            -WorkingDirectory $webglDir -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $serveOut -RedirectStandardError $serveErr
        $startedServe = $true
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-PortListening $resolved) { $ready = $true; break }
            if ($serveProc.HasExited) { break }
        }
        if (-not $ready) {
            throw "Static server did not listen on :$resolved (see $serveErr)"
        }
        Write-Ok "Serving $webglDir"
    }

    if (-not $NoBrowser) {
        Start-Process $demoUrl
        Write-Ok "Opened browser → Offline Demo"
    } else {
        Write-Ok "NoBrowser — open: $demoUrl"
    }

    if ($startedServe) {
        Write-Host 'Press Ctrl+C to stop the static server.' -ForegroundColor DarkGray
        try {
            Wait-Process -Id $serveProc.Id
        } catch {
            # Ctrl+C / process already exited
        }
    } else {
        Write-Ok 'Host already running — exiting (server left up).'
    }
}
finally {
    if ($startedServe -and $null -ne $serveProc -and -not $serveProc.HasExited) {
        Stop-Process -Id $serveProc.Id -Force -ErrorAction SilentlyContinue
    }
}
