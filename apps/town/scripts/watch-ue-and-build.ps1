# Poll for UE 5.8 install, then build + test + screenshot.
# Usage: powershell -File apps/town/scripts/watch-ue-and-build.ps1

. "$PSScriptRoot\_ue-common.ps1"

$logPath = Start-TownLog -Prefix "watch-ue"
try {
    $maxMinutes = 180
    $intervalSec = 60
    $deadline = (Get-Date).AddMinutes($maxMinutes)

    Write-Host "Waiting for UE $UeVersion (max $maxMinutes min, poll every ${intervalSec}s)..."

    while ((Get-Date) -lt $deadline) {
        $ueRoot = Find-UeRoot
        if ($ueRoot) {
            Write-Host "UE found: $ueRoot"
            & "$PSScriptRoot\build-agenttown.ps1"
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            & "$PSScriptRoot\test-agenttown.ps1"
            & "$PSScriptRoot\shoot-agenttown.ps1"
            exit $LASTEXITCODE
        }
        Write-Host "$(Get-Date -Format 'HH:mm:ss') — UE not ready yet..."
        Start-Sleep -Seconds $intervalSec
    }

    Write-Warning "Timed out waiting for UE $UeVersion. Sign in to Epic Launcher and install UE 5.8."
    exit 2
}
finally {
    Stop-TownLog
}
