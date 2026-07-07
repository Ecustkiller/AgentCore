# Town 3D assets (planned single source)

**Status:** placeholder — assets not migrated yet.

## Current location

3D assets for the AI town (Kenney buildings, `Xbot.glb`, textures, etc.) currently live at:

```
apps/desktop/public/simulation/assets/
```

Unreal AgentTown and the retired Desktop R3F viewer both reference this tree today.

## Engine-neutral assets (CC0)

| Pack | License | Use |
|------|---------|-----|
| [Kenney City Kit Commercial](https://kenney.nl/assets/city-kit-commercial) | CC0 | Buildings, awnings, plaza |
| [Kenney Roads](https://kenney.nl/assets/road-pack) | CC0 | Ground tiles (M1+ ) |
| [Quaternius](https://quaternius.com/) | CC0 | Trees, props (M2+ ) |
| Mixamo Xbot | Free rig | NPC walk/idle |
| [Fab](https://www.fab.com/) free section | Per-pack | Optional UE polish |

Import paths: **GLB/OBJ/FBX** work in both Unreal and web preview. Prefer FBX for UE skeleton animations.

## Migration plan

| Phase | Action |
|-------|--------|
| UE-00 (now) | Assets stay in `apps/desktop/public/simulation/assets/` |
| UE-01+ | Copy or CI-sync into `packages/town-assets/` as the **single source** |
| UE-01+ | UE imports from `packages/town-assets/` (symlink or build script → `Content/Town/`) |
| Phase 1 done | Remove duplicate copies from Desktop `public/simulation/assets/` |

## Rules

1. **Do not hand-edit two copies** — change the canonical file once, then sync.
2. **Contract fixtures** (coordinates, tick JSON) stay in `packages/protocol-conformance/fixtures/`, not here.
3. **Runtime data** (personas bio JSON, spawn offsets) may get a sibling `packages/town-data/` later; 3D meshes/materials belong here.

## Related

- [AgentTown 客户端规格](../../docs/06-规划/AgentTown客户端规格.md) §6.3, §7
- Region anchors: `packages/protocol-conformance/fixtures/simulation-region-positions.json`
