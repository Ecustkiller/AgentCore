# TownAssets

AgentTown 3D 资产单一真源（vendored 入库，clone 即用）。

## 内容

| 子目录 | 来源 | 许可 |
|--------|------|------|
| Kenney / Buildings | Kenney City Kit (Commercial) 等 | CC0 |
| Quaternius | Quaternius LowPoly Buildings（精选） | CC0 |
| Nature | Kenney Nature Kit（精选） | CC0 |
| Roads | Kenney City Kit (Roads)（精选） | CC0 |
| Characters | Mixamo Xbot | Mixamo 许可（**非 CC0**） |

> **Mixamo 再分发警示**：Characters 下的 Mixamo Xbot 资产受 Mixamo/Adobe 服务条款约束，
> 不属于 CC0。任何对外再分发本仓库（或包含这些资产的构建产物）之前，必须自行核验
> Mixamo 的再分发权利；建议尽快用可明确再分发的替代资产换掉。

Import 产物：`Prefabs/` + `Resources/Town/TownMeshCatalog.asset`（连 `.meta`）一并入库。

## 新增 / 替换 mesh

1. 将 FBX/GLB（及所需纹理）放入对应子目录
2. Unity Editor：`AgentTown → Import Town Assets`（或 `pnpm town:verify` / Setup Project）
3. 提交源文件 + 生成的 prefab / catalog / `.meta`
