# Quaternius (CC0) — FE-18 landmark meshes

## Pack in use

| Field | Value |
|-------|-------|
| Pack | **LowPoly Buildings** by Quaternius |
| Source | [OpenGameArt — LowPoly Buildings](https://opengameart.org/content/lowpoly-buildings) |
| Zip | `Buildings pack by @Quaternius.zip` (~2.5 MB) |
| Direct | `https://opengameart.org/sites/default/files/Buildings%20pack%20by%20%40Quaternius_0.zip` |
| License | **CC0** |
| Author | [Quaternius](https://quaternius.com/) |

Curated into this folder (flat FBX + `Textures/`):

| Stem | Role (region primary) |
|------|------------------------|
| `Flat` | 广场 |
| `Shop` | 市场 |
| `House5` | 餐厅 |
| `House4` | 面包店 |
| `House2` | 公园 |
| `House` | 住宅区 |
| `Bank` | 镇政厅 |
| `Hospital` | 图书馆 |
| `House3` | 工坊 |
| `Flat2` | 码头 |

## Sync

From repo root:

```powershell
pnpm town:sync-assets
```

Copies `*.fbx` / `*.glb` and `Textures/*` → `packages/town-assets/quaternius/` and Unity `Assets/TownAssets/Quaternius/`.

Then in Unity: **AgentTown → Import Town Assets** (or Setup Project) so `Resources/Town/TownMeshCatalog` picks up the new stems.

Region binding: `TownMeshCatalog.RegionPrimaryMeshNames` (Quaternius) with `RegionKenneyFallbackMeshNames` when a Quaternius stem is missing from the catalog.
