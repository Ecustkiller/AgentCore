# Road tiles (CC0) — main arteries / sidewalks

## Pack in use

| Field | Value |
|-------|-------|
| Pack | **City Kit (Roads) 2.0** by Kenney |
| Source | [kenney.nl/assets/city-kit-roads](https://kenney.nl/assets/city-kit-roads) · [OpenGameArt mirror](https://opengameart.org/content/city-kit-roads) |
| Zip | `kenney_city-kit-roads.zip` (~1.7 MB) |
| Direct | `https://opengameart.org/sites/default/files/kenney_city-kit-roads.zip` |
| License | **CC0** (see `License.txt`) |
| Author | [Kenney](https://kenney.nl/) |

Curated into this folder (flat GLB only — do **not** vendor the full 65+ pack):

| Stem | Role |
|------|------|
| `road-straight` | Straight asphalt segment |
| `road-crossroad` | Four-way crossing |
| `road-bend` | Corner / bend |
| `road-crossing` | Pedestrian crossing stripe |
| `road-intersection` | T / branch junction |
| `road-bend-sidewalk` | Bend with sidewalk |
| `road-side` | Sidewalk / shoulder strip |
| `tile-low` | Low ground / path accent |

Native Kenney tile footprint ≈ **1×1 m** (position accessor −0.5…0.5). Runtime scale (~7.5 on main arteries) matches the widened colour-slab roads in `TownVisualLayout.Roads`.

## Sync

From repo root:

```powershell
pnpm town:sync-assets
```

Copies `roads/*.glb` → `packages/town-assets/roads/` and Unity `Assets/TownAssets/Roads/`.

Then in Unity: **AgentTown → Import Town Assets** so `TownMeshCatalog` road pool picks up the stems.

Runtime: `TownVisualLayout.RoadTiles` + `TownBuilder`; empty catalog → existing coloured road slabs only (no crash). Colliders stripped so NavMesh (ground bake) stays walkable.
