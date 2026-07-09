# Run AgentTown.Simulation automation tests via UnrealEditor-Cmd.
# Usage: pwsh apps/town/scripts/test-agenttown.ps1
#
# Tests include:
#   AgentTown.Simulation.WireCoordinate.* — coordinate fixture contract (×100 world scale)
#   AgentTown.Simulation.Session.* — ApplySnapshot transforms
#   AgentTown.Simulation.Npc.SnapshotPlacesAtMarket — snapshot -> scaled UE placement
# (Real NavMesh walking is a runtime/PIE concern: verify via PIE Play, not headless automation.)

. "$PSScriptRoot\_ue-common.ps1"

$logPath = Start-TownLog -Prefix "test-agenttown"
try {
    $ueRoot = Find-UeRoot -Version $UeVersion
    if (-not $ueRoot) {
        Write-Warning "UE $UeVersion not installed. Run: pnpm town:install-ue"
        exit 2
    }

    if (-not (Test-AgentTownBuilt -UeRoot $ueRoot)) {
        Write-Warning "AgentTown not built. Run: pnpm town:build"
        exit 2
    }

    $editorCmd = Get-UeEditorCmd -UeRoot $ueRoot
    Write-Host "Running automation: AgentTown.Simulation"
    Write-Host "> $editorCmd `"$UProject`" -ExecCmds=..."

    & $editorCmd $UProject `
        -ExecCmds="Automation RunTests AgentTown.Simulation; Quit" `
        -unattended -nopause -log

    if ($LASTEXITCODE -ne 0) {
        throw "Automation tests failed (exit $LASTEXITCODE). See log: $logPath"
    }

    Write-Host "Automation tests passed."
    exit 0
}
finally {
    Stop-TownLog
}
