# Shared helpers for AgentTown UE automation scripts.
# Dot-source from sibling scripts: . "$PSScriptRoot\_ue-common.ps1"

$ErrorActionPreference = "Stop"

$script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$script:TownRoot = Join-Path $RepoRoot "apps\town"
$script:UProject = Join-Path $TownRoot "AgentTown.uproject"
$script:LogsDir = Join-Path $TownRoot "logs"
$script:ShootOutDir = Join-Path $TownRoot "shoot-out"
$script:UeVersion = "5.8"
$script:UeFolderName = "UE_$UeVersion"
$script:EpicGamesRoot = "C:\Program Files\Epic Games"
$script:UeRoot = Join-Path $EpicGamesRoot $UeFolderName

function Ensure-TownDirs {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $ShootOutDir | Out-Null
}

function New-TownLogPath {
    param([string]$Prefix)
    Ensure-TownDirs
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return Join-Path $LogsDir "$Prefix-$stamp.log"
}

function Start-TownLog {
    param([string]$Prefix)
    $path = New-TownLogPath -Prefix $Prefix
    Write-Host "Logging to $path"
    Start-Transcript -Path $path -Append | Out-Null
    return $path
}

function Stop-TownLog {
    try { Stop-Transcript | Out-Null } catch { }
}

function Get-InstalledUeRoots {
    if (-not (Test-Path $EpicGamesRoot)) { return @() }
    Get-ChildItem -Path $EpicGamesRoot -Directory -Filter "UE_*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
}

function Find-UeRoot {
    param(
        [string]$Version = $UeVersion
    )
    $expected = Join-Path $EpicGamesRoot "UE_$Version"
    if (Test-Path (Join-Path $expected "Engine\Build\BatchFiles\Build.bat")) {
        return $expected
    }

    foreach ($dir in (Get-InstalledUeRoots)) {
        $buildBat = Join-Path $dir.FullName "Engine\Build\BatchFiles\Build.bat"
        if (Test-Path $buildBat) {
            return $dir.FullName
        }
    }
    return $null
}

function Get-UeEditorCmd {
    param([string]$UeRoot)
    $cmd = Join-Path $UeRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
    if (-not (Test-Path $cmd)) {
        throw "UnrealEditor-Cmd.exe not found: $cmd"
    }
    return $cmd
}

function Test-AgentTownBuilt {
    param([string]$UeRoot = (Find-UeRoot))
    if (-not $UeRoot) { return $false }
    $editorDll = Join-Path $TownRoot "Binaries\Win64\UnrealEditor-AgentTown.dll"
    return Test-Path $editorDll
}

function Find-EpicLauncherExe {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"),
        (Join-Path $env:ProgramFiles "Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe"),
        (Join-Path $env:ProgramFiles "Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"),
        (Join-Path $env:LOCALAPPDATA "EpicGamesLauncher\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe"),
        (Join-Path $env:LOCALAPPDATA "EpicGamesLauncher\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe")
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    $launcherRoot = Join-Path $env:ProgramFiles "Epic Games\Launcher"
    if (Test-Path $launcherRoot) {
        $found = Get-ChildItem -Path $launcherRoot -Recurse -Filter "EpicGamesLauncher.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
        if ($found) { return $found }
    }
    $cmd = Get-Command EpicGamesLauncher.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}


function Invoke-UeGenerateProjectFiles {
    param([string]$UeRoot)
    $genBat = Join-Path $UeRoot "Engine\Build\BatchFiles\GenerateProjectFiles.bat"
    $buildBat = Join-Path $UeRoot "Engine\Build\BatchFiles\Build.bat"
    $args = @(
        "-projectfiles",
        "-project=`"$UProject`"",
        "-game",
        "-rocket",
        "-progress"
    )
    if (Test-Path $genBat) {
        Invoke-UeBatch -BatchPath $genBat -Arguments $args
        return
    }
    if (Test-Path $buildBat) {
        Write-Host "GenerateProjectFiles.bat missing (UE 5.8+); using Build.bat -projectfiles."
        Invoke-UeBatch -BatchPath $buildBat -Arguments $args
        return
    }
    throw "Neither GenerateProjectFiles.bat nor Build.bat found under $UeRoot"
}

function Invoke-UeBatch {
    param(
        [string]$BatchPath,
        [string[]]$Arguments
    )
    if (-not (Test-Path $BatchPath)) {
        throw "Batch file not found: $BatchPath"
    }
    Write-Host "> $BatchPath $($Arguments -join ' ')"
    & $BatchPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $BatchPath"
    }
}
