# TownAssets

AgentTown 3D 资产单一真源（vendored 入库，clone 即用）。

## 内容

| 子目录 | 来源 | 许可 |
|--------|------|------|
| Kenney / Buildings | Kenney City Kit (Commercial) 等 | CC0 |
| Quaternius | Quaternius LowPoly Buildings（精选） | CC0 |
| Nature | Kenney Nature Kit（精选） | CC0 |
| Roads | Kenney City Kit (Roads)（精选） | CC0 |
| Characters | Mixamo Xbot | Mixamo 许可 |

Import 产物：`Prefabs/` + `Resources/Town/TownMeshCatalog.asset`（连 `.meta`）一并入库。

## 新增 / 替换 mesh

1. 将 FBX/GLB（及所需纹理）放入对应子目录
2. Unity Editor：`AgentTown → Import Town Assets`（或 `pnpm town:verify` / Setup Project）
3. 提交源文件 + 生成的 prefab / catalog / `.meta`
