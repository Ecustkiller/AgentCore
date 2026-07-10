Kenney / Quaternius / Nature / Roads / Xbot 二进制由 `pnpm town:sync-assets` 从 Desktop public 同步到本包，再镜像到 Unity `apps/town/Assets/TownAssets/`。大文件默认 gitignore；本 README 入仓。

## 同步

```powershell
pnpm town:sync-assets
# Editor: AgentTown → Import Town Assets  → Resources/Town/TownMeshCatalog.asset
```

## 布局（sync 后）

```
packages/town-assets/
  ├── buildings/*.glb              # Kenney City Kit Commercial 精选 10
  ├── kenney-fbx/*.fbx (+ Textures/)
  ├── kenney-glb/*.glb
  ├── quaternius/*.fbx (+ Textures/) # FE-18 Quaternius LowPoly Buildings（10）
  ├── nature/*.glb                 # Kenney Nature Kit 精选（10）
  ├── roads/*.glb                  # Kenney City Kit (Roads) 精选（8）
  ├── Xbot.glb
  └── README.md
```

Unity 侧：`Assets/TownAssets/{Kenney,Quaternius,Nature,Roads,Buildings,Characters}` → Import 生成 Prefabs + catalog（building + nature + road 池）。

## 引擎无关资产（CC0）

| Pack | License | Use |
|------|---------|-----|
| [Kenney City Kit Commercial](https://kenney.nl/assets/city-kit-commercial) | CC0 | 建筑 / 雨棚 / 广场（填充 + Kenney fallback） |
| [Quaternius LowPoly Buildings](https://opengameart.org/content/lowpoly-buildings) | CC0 | FE-18 区域地标（源：`public/simulation/assets/quaternius/`，10 FBX） |
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 | 公园/路边自然物（源：`public/simulation/assets/nature/`，精选 10 GLB） |
| [Kenney City Kit (Roads)](https://kenney.nl/assets/city-kit-roads) | CC0 | 主干道路 mesh（源：`public/simulation/assets/roads/`，精选 8 GLB；无资产回退色块） |
| Mixamo Xbot | Free rig | NPC |

## Rules

1. **勿双份手改** — 改 Desktop 源或本包一次再 sync。
2. **契约 fixtures** 在 `packages/protocol-conformance/fixtures/`，不放这里。
3. **自然物 / 道路只进精选** — 勿把 Nature Kit 全包 330+ 或 Roads 全包 65+ 拷进仓。
4. 本包只放 3D mesh/材质。

## Related

- [apps/town/README.md](../../apps/town/README.md) · [EDITOR-WIRING §4](../../apps/town/EDITOR-WIRING.md)
- [AgentTown 客户端规格](../../docs/06-规划/AgentTown客户端规格.md) §6.3、§7
