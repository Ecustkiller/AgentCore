# Sync Kenney / Quaternius / Nature / Roads / Xbot assets into packages/town-assets (canonical)
# and Unity Assets/TownAssets.
# Usage (repo root or anywhere):
#   pwsh apps/town/scripts/sync-assets.ps1
#
# Quaternius (CC0): place GLB/FBX under apps/desktop/public/simulation/assets/quaternius/
# (+ optional Textures/). Prefer Quaternius region primaries; Kenney fills / fallback.
# Nature (CC0): curated Kenney Nature Kit GLBs under .../assets/nature/ (not the full pack).
# Roads (CC0): curated Kenney City Kit (Roads) GLBs under .../assets/roads/ (not the full pack).

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$Src = Join-Path $RepoRoot 'apps\desktop\public\simulation\assets'
$Pkg = Join-Path $RepoRoot 'packages\town-assets'
$Unity = Join-Path $RepoRoot 'apps\town\Assets\TownAssets'

if (-not (Test-Path $Src)) {
    throw "Source assets not found: $Src"
}

function Ensure-Dir([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Copy-Glob([string]$Base, [string]$Pattern, [string]$Dest) {
    Ensure-Dir $Dest
    $n = 0
    Get-ChildItem -Path (Join-Path $Base $Pattern) -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName -Destination (Join-Path $Dest $_.Name) -Force
        $n++
    }
    return $n
}

Ensure-Dir $Pkg
Ensure-Dir (Join-Path $Pkg 'buildings')
Ensure-Dir (Join-Path $Pkg 'kenney-fbx')
Ensure-Dir (Join-Path $Pkg 'kenney-glb')
Ensure-Dir (Join-Path $Pkg 'quaternius')
Ensure-Dir (Join-Path $Pkg 'nature')
Ensure-Dir (Join-Path $Pkg 'roads')
Ensure-Dir $Unity
Ensure-Dir (Join-Path $Unity 'Buildings')
Ensure-Dir (Join-Path $Unity 'Kenney')
Ensure-Dir (Join-Path $Unity 'Quaternius')
Ensure-Dir (Join-Path $Unity 'Nature')
Ensure-Dir (Join-Path $Unity 'Roads')
Ensure-Dir (Join-Path $Unity 'Characters')

$copied = 0
$copied += Copy-Glob $Src 'buildings\*.glb' (Join-Path $Pkg 'buildings')
$copied += Copy-Glob $Src 'kenney_city-kit-commercial\Models\FBX format\*.fbx' (Join-Path $Pkg 'kenney-fbx')
$copied += Copy-Glob $Src 'kenney_city-kit-commercial\Models\GLB format\*.glb' (Join-Path $Pkg 'kenney-glb')
$copied += Copy-Glob $Src 'quaternius\*.glb' (Join-Path $Pkg 'quaternius')
$copied += Copy-Glob $Src 'quaternius\*.fbx' (Join-Path $Pkg 'quaternius')
$copied += Copy-Glob $Src 'nature\*.glb' (Join-Path $Pkg 'nature')
$copied += Copy-Glob $Src 'roads\*.glb' (Join-Path $Pkg 'roads')
if (Test-Path (Join-Path $Src 'Xbot.glb')) {
    Copy-Item (Join-Path $Src 'Xbot.glb') (Join-Path $Pkg 'Xbot.glb') -Force
    $copied++
}

# Textures next to FBX (Kenney colormap)
$texSrc = Join-Path $Src 'kenney_city-kit-commercial\Models\FBX format\Textures'
if (Test-Path $texSrc) {
    $texDst = Join-Path $Pkg 'kenney-fbx\Textures'
    Ensure-Dir $texDst
    Copy-Item (Join-Path $texSrc '*') $texDst -Recurse -Force
}

# Quaternius atlas textures (FE-18)
$quatTexSrc = Join-Path $Src 'quaternius\Textures'
if (Test-Path $quatTexSrc) {
    $quatTexDst = Join-Path $Pkg 'quaternius\Textures'
    Ensure-Dir $quatTexDst
    Copy-Item (Join-Path $quatTexSrc '*') $quatTexDst -Force
    $copied += @(Get-ChildItem $quatTexDst -File -ErrorAction SilentlyContinue).Count
}

# Nature / roads licenses (optional)
$natureLicense = Join-Path $Src 'nature\License.txt'
if (Test-Path $natureLicense) {
    Copy-Item $natureLicense (Join-Path $Pkg 'nature\License.txt') -Force
}
$roadsLicense = Join-Path $Src 'roads\License.txt'
if (Test-Path $roadsLicense) {
    Copy-Item $roadsLicense (Join-Path $Pkg 'roads\License.txt') -Force
}

# Roads GLBs reference Textures/colormap.png (Kenney City Kit atlas). Prefer roads-local
# copy; fall back to commercial kit atlas so glTFast can import the curated road set.
$roadsTexPkg = Join-Path $Pkg 'roads\Textures'
Ensure-Dir $roadsTexPkg
$roadsColormapCandidates = @(
    (Join-Path $Src 'roads\Textures\colormap.png'),
    (Join-Path $Src 'kenney_city-kit-commercial\Models\GLB format\Textures\colormap.png'),
    (Join-Path $Src 'kenney_city-kit-commercial\Models\FBX format\Textures\colormap.png'),
    (Join-Path $Src 'buildings\Textures\colormap.png')
)
foreach ($candidate in $roadsColormapCandidates) {
    if (Test-Path $candidate) {
        Copy-Item $candidate (Join-Path $roadsTexPkg 'colormap.png') -Force
        break
    }
}

# Mirror into Unity import folder
Copy-Item (Join-Path $Pkg 'buildings\*') (Join-Path $Unity 'Buildings') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Pkg 'kenney-fbx\*') (Join-Path $Unity 'Kenney') -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $Pkg 'quaternius')) {
    $quatUnity = Join-Path $Unity 'Quaternius'
    Ensure-Dir $quatUnity
    Get-ChildItem (Join-Path $Pkg 'quaternius') -File -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $quatUnity $_.Name) -Force
    }
    $quatTexPkg = Join-Path $Pkg 'quaternius\Textures'
    if (Test-Path $quatTexPkg) {
        $quatTexUnity = Join-Path $quatUnity 'Textures'
        Ensure-Dir $quatTexUnity
        Copy-Item (Join-Path $quatTexPkg '*') $quatTexUnity -Force
    }
}
if (Test-Path (Join-Path $Pkg 'nature')) {
    $natureUnity = Join-Path $Unity 'Nature'
    Ensure-Dir $natureUnity
    Get-ChildItem (Join-Path $Pkg 'nature') -File -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $natureUnity $_.Name) -Force
    }
}
if (Test-Path (Join-Path $Pkg 'roads')) {
    $roadsUnity = Join-Path $Unity 'Roads'
    Ensure-Dir $roadsUnity
    Get-ChildItem (Join-Path $Pkg 'roads') -File -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $roadsUnity $_.Name) -Force
    }
    $roadsTexPkgMirror = Join-Path $Pkg 'roads\Textures'
    if (Test-Path $roadsTexPkgMirror) {
        $roadsTexUnity = Join-Path $roadsUnity 'Textures'
        Ensure-Dir $roadsTexUnity
        Copy-Item (Join-Path $roadsTexPkgMirror '*') $roadsTexUnity -Force
    }
}
if (Test-Path (Join-Path $Pkg 'Xbot.glb')) {
    Copy-Item (Join-Path $Pkg 'Xbot.glb') (Join-Path $Unity 'Characters\Xbot.glb') -Force
}

$quatMeshCount = @(Get-ChildItem (Join-Path $Pkg 'quaternius') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(fbx|glb)$' }).Count
$natureMeshCount = @(Get-ChildItem (Join-Path $Pkg 'nature') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(fbx|glb)$' }).Count
$roadsMeshCount = @(Get-ChildItem (Join-Path $Pkg 'roads') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(fbx|glb)$' }).Count
Write-Host "Synced $copied primary files → $Pkg (quaternius: $quatMeshCount, nature: $natureMeshCount, roads: $roadsMeshCount)"
Write-Host "Unity import folder: $Unity"
Write-Host "Next: pnpm town:open → AgentTown/Import Town Assets (or Setup Project) → Play (EDITOR-WIRING §4)"
