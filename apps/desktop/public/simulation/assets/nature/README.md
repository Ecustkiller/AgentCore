# Nature props (CC0) — park / roadside foliage

## Pack in use

| Field | Value |
|-------|-------|
| Pack | **Nature Kit (2.1)** by Kenney |
| Source | [kenney.nl/assets/nature-kit](https://kenney.nl/assets/nature-kit) · [OpenGameArt mirror](https://opengameart.org/content/nature-kit) |
| Zip | `Nature Kit (2.1).zip` (~10.5 MB) |
| Direct | `https://opengameart.org/sites/default/files/Nature%20Kit%20%282.1%29.zip` |
| License | **CC0** (see `License.txt`) |
| Author | [Kenney](https://kenney.nl/) |

Curated into this folder (flat GLB only — do **not** vendor the full 330+ pack):

| Stem | Role |
|------|------|
| `tree_oak` | Large deciduous |
| `tree_default` | Medium deciduous |
| `tree_tall` | Tall deciduous |
| `tree_pineDefaultA` | Pine accent |
| `tree_small` | Small / roadside |
| `plant_bush` | Bush |
| `plant_bushDetailed` | Dense bush |
| `plant_bushSmall` | Low bush |
| `grass_large` | Grass clump |
| `flower_yellowA` | Flower accent |

## Sync

From repo root:

```powershell
pnpm town:sync-assets
```

Copies `nature/*.glb` → `packages/town-assets/nature/` and Unity `Assets/TownAssets/Nature/`.

Then in Unity: **AgentTown → Import Town Assets** so `TownMeshCatalog` nature pool picks up the stems.

Runtime: `TownVisualLayout.NatureProps` + `TownBuilder` spawn; empty catalog → green primitive fallback (no crash).
