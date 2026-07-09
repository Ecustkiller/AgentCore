# Generate VS project files, compile AgentTownEditor, run automation tests.
# Idempotent — skips generate/build when outputs are up to date unless -Force.
#
# Usage: pwsh apps/town/scripts/build-agenttown.ps1 [-Force] [-SkipTests]

param(
    [switch]$Force,
    [switch]$SkipTests
)

. "$PSScriptRoot\_ue-common.ps1"

$logPath = Start-TownLog -Prefix "build-agenttown"
try {
    $ueRoot = Find-UeRoot -Version $UeVersion
    if (-not $ueRoot) {
        Write-Warning "UE $UeVersion not installed. Run: pnpm town:install-ue"
        exit 2
    }
    Write-Host "Using UE: $ueRoot"

    if (-not (Test-Path $UProject)) {
        throw "Project file not found: $UProject"
    }

    $buildBat = Join-Path $ueRoot "Engine\Build\BatchFiles\Build.bat"
    $slnPath = Join-Path $TownRoot "AgentTown.sln"

    if ($Force -or -not (Test-Path $slnPath)) {
        Invoke-UeGenerateProjectFiles -UeRoot $ueRoot
    } else {
        Write-Host "Skipping GenerateProjectFiles (AgentTown.sln exists; use -Force to regenerate)."
    }

    $editorDll = Join-Path $TownRoot "Binaries\Win64\UnrealEditor-AgentTown.dll"
    if ($Force -or -not (Test-Path $editorDll)) {
        Invoke-UeBatch -BatchPath $buildBat -Arguments @(
            "AgentTownEditor",
            "Win64",
            "Development",
            "-Project=`"$UProject`"",
            "-WaitMutex",
            "-FromMsBuild"
        )
    } else {
        Write-Host "Skipping compile (UnrealEditor-AgentTown.dll exists; use -Force to rebuild)."
    }

    if ($SkipTests) {
        Write-Host "Skipping automation tests (-SkipTests)."
        exit 0
    }

    & "$PSScriptRoot\test-agenttown.ps1"
    exit $LASTEXITCODE
}
finally {
    Stop-TownLog
}
