# Sync Kenney / Xbot assets from desktop public folder into UE Content source tree.
# Run from repo root: pwsh apps/town/scripts/sync-assets.ps1
# Then in UE Editor: import Content/Town/SourceAssets/**/*.glb (Automated)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$Src = Join-Path $RepoRoot "apps\desktop\public\simulation\assets"
$Dst = Join-Path $RepoRoot "apps\town\Content\Town\SourceAssets"

if (-not (Test-Path $Src)) {
    Write-Error "Source assets not found: $Src"
}

New-Item -ItemType Directory -Force -Path $Dst | Out-Null

# Kenney GLB pack + curated buildings + character
$patterns = @(
    "kenney_city-kit-commercial\Models\GLB format\*.glb",
    "buildings\*.glb",
    "Xbot.glb"
)

$copied = 0
foreach ($pat in $patterns) {
    $full = Join-Path $Src $pat
    Get-ChildItem -Path $full -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName -Destination $Dst -Force
        $copied++
    }
}

Write-Host "Synced $copied files to $Dst"
Write-Host "Next: open AgentTown.uproject -> Content Browser -> Import into Content/Town/Meshes"
