# One-shot Unity project verify: setup + EditMode tests + Play smoke.
# Usage: pwsh apps/town/scripts/verify-unity.ps1
# Close the Unity Editor before running (single-instance lock).

param(
    [string]$Version = '6000.0.78f1',
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "OK $msg" -ForegroundColor Green }
function Write-Err([string]$msg) { Write-Host $msg -ForegroundColor Red }

function Get-UnityExe {
    param([string]$Ver)
    $candidates = @(
        "C:\Program Files\Unity\Hub\Editor\$Ver\Editor\Unity.exe",
        "C:\Program Files\Unity\Hub\Editor\$Ver-x86_64\Editor\Unity.exe"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    throw "Unity $Ver not found. Run: pwsh apps/town/scripts/install-unity.ps1 -LocalOnly"
}

function Invoke-UnityBatch {
    param(
        [string]$Unity,
        [string]$Project,
        [string]$LogFile,
        [string[]]$ExtraArgs,
        [switch]$NoQuit
    )
    New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
    $args = @(
        '-batchmode', '-nographics',
        '-projectPath', $Project,
        '-logFile', $LogFile
    )
    if (-not $NoQuit) { $args += '-quit' }
    $args += $ExtraArgs

    Write-Host "> `"$Unity`" $($args -join ' ')"
    & $Unity @args
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }

    if (Test-Path $LogFile) {
        $tail = Get-Content $LogFile -Tail 80
        $rcLine = $tail | Where-Object { $_ -match 'return code (\d+)' } | Select-Object -Last 1
        if ($rcLine -match 'return code (\d+)') {
            $code = [int]$Matches[1]
        }
    }

    # Play smoke uses -NoQuit; ensure no headless Unity keeps the project locked.
    if ($NoQuit) {
        Start-Sleep -Seconds 2
        Get-Process -Name 'Unity' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -eq '' } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }

    if ($code -ne 0) {
        $tail = @()
        if (Test-Path $LogFile) {
            $tail = Get-Content $LogFile -Tail 40
        }
        throw "Unity exited $code. Log: $LogFile`n$($tail -join "`n")"
    }

    return $LogFile
}

function Assert-LogContains {
    param([string]$LogFile, [string]$Pattern, [string]$StepName)
    for ($i = 0; $i -lt 60; $i++) {
        if ((Test-Path $LogFile) -and ((Get-Content $LogFile -Raw) -match $Pattern)) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "${StepName} failed — expected log pattern '$Pattern' in $LogFile"
}

$unity = Get-UnityExe -Ver $Version
$logDir = Join-Path $ProjectPath 'logs'
$results = Join-Path $logDir 'editmode-results.xml'

if (Get-Process -Name 'Unity' -ErrorAction SilentlyContinue) {
    Write-Err 'Unity Editor is open. Close it, then re-run this script.'
    exit 2
}

Write-Step '1/3 Project setup (URP + Town.unity + Bootstrap HUD refs)'
$setupLog = Invoke-UnityBatch -Unity $unity -Project $ProjectPath -LogFile (Join-Path $logDir 'verify-setup.log') -ExtraArgs @(
    '-executeMethod', 'AgentTown.Editor.AgentTownProjectSetup.SetupFromBatch'
)
Assert-LogContains -LogFile $setupLog -Pattern '\[AgentTown\] Project setup complete' -StepName 'Setup'
Start-Sleep -Seconds 3
Write-Ok 'Setup complete'

Write-Step '2/3 EditMode tests (14 cases)'
$testLog = Invoke-UnityBatch -Unity $unity -Project $ProjectPath -LogFile (Join-Path $logDir 'verify-tests.log') -ExtraArgs @(
    '-runTests', '-testPlatform', 'editmode',
    '-assemblyNames', 'AgentTown.EditModeTests',
    '-testResults', $results
)
Start-Sleep -Seconds 3
if (-not (Test-Path $results)) {
    throw "Missing test results: $results"
}
[xml]$xml = Get-Content $results
if ([int]$xml.'test-run'.failed -gt 0) {
    throw "EditMode tests failed: $($xml.'test-run'.failed) failed, $($xml.'test-run'.passed) passed"
}
Write-Ok "EditMode tests: $($xml.'test-run'.passed)/$($xml.'test-run'.total) passed"

Write-Step '3/3 Play smoke (runtime town spawn)'
$playLog = Invoke-UnityBatch -Unity $unity -Project $ProjectPath -LogFile (Join-Path $logDir 'verify-play.log') -NoQuit -ExtraArgs @(
    '-executeMethod', 'AgentTown.Editor.AgentTownBatchVerify.RunPlaySmokeFromBatch'
)
Assert-LogContains -LogFile $playLog -Pattern 'Play smoke PASSED|NavMesh baked over town ground' -StepName 'Play smoke'
Write-Ok 'Play smoke passed'

Write-Host ''
Write-Ok 'AgentTown Unity project verified end-to-end.'
Write-Host 'Open Hub → town → Play Assets/Scenes/Town.unity' -ForegroundColor Yellow
exit 0
