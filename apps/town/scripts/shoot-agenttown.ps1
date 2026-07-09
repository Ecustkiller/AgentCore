# Capture a PIE/editor screenshot when UE is available. Gracefully skips when not.
# Output: apps/town/shoot-out/agenttown-pie.png
#
# Usage: pwsh apps/town/scripts/shoot-agenttown.ps1

. "$PSScriptRoot\_ue-common.ps1"

$logPath = Start-TownLog -Prefix "shoot-agenttown"
try {
    Ensure-TownDirs

    $ueRoot = Find-UeRoot -Version $UeVersion
    if (-not $ueRoot) {
        Write-Host "SKIP: UE $UeVersion not installed — no screenshot taken."
        exit 0
    }

    if (-not (Test-AgentTownBuilt -UeRoot $ueRoot)) {
        Write-Host "SKIP: AgentTown not built — run pnpm town:build first."
        exit 0
    }

    $editorCmd = Get-UeEditorCmd -UeRoot $ueRoot
    $shotName = "agenttown-pie"
    $outFile = Join-Path $ShootOutDir "agenttown-pie.png"
    $screensDir = Join-Path $TownRoot "Saved\Screenshots\Windows"

    if (Test-Path $screensDir) {
        Get-ChildItem -Path $screensDir -Filter "*.png" -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    # Load default map, wait for render, capture 1920x1080, quit.
    $execCmds = "open /Engine/Maps/Templates/OpenWorld; Sleep 8; HighResShot 1920x1080filename=$shotName; Quit"
    Write-Host "Capturing screenshot via UnrealEditor-Cmd..."
    Write-Host "> $editorCmd (HighResShot 1920x1080)"

    & $editorCmd $UProject `
        -ExecCmds=$execCmds `
        -unattended -nopause -log `
        -windowed -ResX=1920 -ResY=1080

    $candidates = @(
        (Join-Path $screensDir "$shotName.png"),
        (Join-Path $screensDir "HighresScreenshot00000.png")
    )
    if (Test-Path $screensDir) {
        $latest = Get-ChildItem -Path $screensDir -Filter "*.png" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($latest) { $candidates += $latest.FullName }
    }

    $source = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $source) {
        Write-Warning "Screenshot not found under $screensDir — editor may have exited early."
        exit 2
    }

    Copy-Item -Path $source -Destination $outFile -Force
    Write-Host "Wrote $outFile"
    exit 0
}
finally {
    Stop-TownLog
}
