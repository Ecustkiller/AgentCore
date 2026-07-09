# Ensure Epic Games Launcher (winget) and detect / optionally install UE 5.8.
# Idempotent — safe to re-run. Does NOT download multi-GB UE without explicit opt-in.
#
# Usage (repo root):
#   pwsh apps/town/scripts/install-ue.ps1
#   $env:AGENTTOWN_INSTALL_UE = '1'; pwsh apps/town/scripts/install-ue.ps1
#
# Silent UE install (documented — requires Epic Launcher + signed-in account):
#   & "$env:ProgramFiles(x86)\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe" `
#     -silent -install -appUnrealEngine=UE_5.8
#
# Offline MSI (documented — download from Epic Developer portal first):
#   msiexec /i "C:\Path\To\UnrealEngine-5.8.msi" /qn

param(
    [switch]$InstallUe
)

. "$PSScriptRoot\_ue-common.ps1"

$logPath = Start-TownLog -Prefix "install-ue"
try {
    $installed = Get-InstalledUeRoots
    if ($installed.Count -gt 0) {
        Write-Host "Detected Unreal Engine installs:"
        $installed | ForEach-Object { Write-Host "  - $($_.FullName)" }
    } else {
        Write-Host "No UE_* folders under $EpicGamesRoot"
    }

    $ueRoot = Find-UeRoot -Version $UeVersion
    if ($ueRoot) {
        Write-Host "UE $UeVersion ready: $ueRoot"
        exit 0
    }

    Write-Host ""
    Write-Host "UE $UeVersion not found. Options:"
    Write-Host "  1) Epic Launcher CLI (after launcher is installed and you are signed in):"
    Write-Host "     EpicGamesLauncher.exe -silent -install -appUnrealEngine=UE_5.8"
    Write-Host "  2) Offline MSI from Epic Developer portal:"
    Write-Host "     msiexec /i `"<path>\UnrealEngine-$UeVersion.msi`" /qn"
    Write-Host "  3) Re-run with install opt-in (launcher download only, no direct multi-GB fetch here):"
    Write-Host "     `$env:AGENTTOWN_INSTALL_UE='1'; pnpm town:install-ue"
    Write-Host ""

    $launcherExe = Find-EpicLauncherExe
    $launcherInstalled = [bool]$launcherExe

    if (-not $launcherInstalled) {
        Write-Host "Epic Games Launcher not found. Attempting winget install (EpicGames.EpicGamesLauncher)..."
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            Write-Warning "winget unavailable. Install Epic Games Launcher manually, then re-run."
            exit 2
        }
        $wingetOut = & winget install --id EpicGames.EpicGamesLauncher -e --accept-package-agreements --accept-source-agreements 2>&1 | Out-String
        Write-Host $wingetOut.Trim()
        $launcherExe = Find-EpicLauncherExe
        $launcherInstalled = [bool]$launcherExe
        $alreadyInstalled = $wingetOut -match "existing package|已安装的现有包|already installed"
        if (-not $launcherInstalled -and $LASTEXITCODE -ne 0 -and -not $alreadyInstalled) {
            Write-Warning "winget install failed (exit $LASTEXITCODE). Install launcher manually."
            exit 2
        }
        if (-not $launcherInstalled -and $alreadyInstalled) {
            Write-Warning "winget reports Epic Launcher installed but executable not found at default paths."
        }
    }

    if ($launcherInstalled) {
        Write-Host "Epic Games Launcher: $launcherExe"
    }

    $shouldInstallUe = $InstallUe.IsPresent -or ($env:AGENTTOWN_INSTALL_UE -eq "1")
    if (-not $shouldInstallUe) {
        Write-Host "Skipping UE download (set AGENTTOWN_INSTALL_UE=1 to trigger launcher silent install)."
        exit 2
    }

    if (-not $launcherInstalled) {
        Write-Warning "Cannot install UE — Epic Games Launcher still missing after winget attempt."
        exit 2
    }

    Write-Host "Requesting UE $UeVersion via Epic Launcher (silent). This may take a long time..."
    & $launcherExe -silent -install -appUnrealEngine=$UeFolderName
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Epic Launcher install command exited $LASTEXITCODE. Check launcher / sign-in."
        exit 2
    }

    $ueRoot = Find-UeRoot -Version $UeVersion
    if ($ueRoot) {
        Write-Host "UE $UeVersion installed: $ueRoot"
        exit 0
    }

    Write-Warning "Install requested but UE $UeVersion not detected yet. Check Epic Launcher downloads."
    exit 2
}
finally {
    Stop-TownLog
}
