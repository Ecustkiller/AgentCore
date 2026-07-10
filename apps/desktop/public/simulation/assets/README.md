# Simulation 3D assets (CC0)

| Asset | Source | Use |
|-------|--------|-----|
| `Xbot.glb` | [three.js examples](https://three.js.org/examples/models/gltf/Xbot.glb) (Mixamo rig) | NPC walk/idle |
| `buildings/*.glb` | [Kenney City Kit Commercial](https://kenney.nl/assets/city-kit-commercial) | Ten town zones (fill + Kenney fallback) |
| `quaternius/*` | [Quaternius LowPoly Buildings](https://opengameart.org/content/lowpoly-buildings) (CC0) | FE-18 region landmarks (10 FBX + Textures) |
| `nature/*.glb` | [Kenney Nature Kit 2.1](https://kenney.nl/assets/nature-kit) (CC0) | Park / roadside trees, bushes, grass, flowers (curated 10) |
| `roads/*.glb` | [Kenney City Kit (Roads) 2.0](https://kenney.nl/assets/city-kit-roads) (CC0) | Main arteries / crossings / sidewalks (curated 8) |

## Quaternius (FE-18)

- Pack: **LowPoly Buildings** by Quaternius — OpenGameArt mirror, CC0.
- Zip: `Buildings pack by @Quaternius.zip` (~2.5 MB).
- Layout: flat `*.fbx` stems + `Textures/*.png` under `quaternius/`.
- After adding/replacing files: `pnpm town:sync-assets` → Unity **Import Town Assets**.

Kenney curated GLBs in `buildings/` remain the fill layer and Kenney-name fallback when a Quaternius primary is absent.

## Nature (park foliage)

- Pack: **Nature Kit (2.1)** by Kenney — CC0; see `nature/README.md` + `nature/License.txt`.
- Curated **10** GLBs only (not the full 330+ pack): 5 trees, 3 bushes, grass, flower.
- Sync → `packages/town-assets/nature/` + Unity `TownAssets/Nature/` → catalog nature pool.
- Runtime: `TownVisualLayout.NatureProps` + `TownBuilder`; empty catalog → green primitive fallback.

## Roads (main arteries)

- Pack: **City Kit (Roads) 2.0** by Kenney — CC0; see `roads/README.md` + `roads/License.txt`.
- Curated **8** GLBs only (not the full 65+ pack): straight, crossroad, bend, crossing, intersection, sidewalk bend, side strip, low tile.
- Sync → `packages/town-assets/roads/` + Unity `TownAssets/Roads/` → catalog road pool.
- Runtime: coloured slabs always (branches / park / dock); when catalog has roads, `TownVisualLayout.RoadTiles` mesh overlays main + key junctions. Empty catalog → slabs only.
