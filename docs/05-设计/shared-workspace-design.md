# Phase 2：文件夹绑定目录 — 共享工作区

## 1. 目标

在 Phase 1「Folder = 纯分组 + 对话自带 scratch」的基础上，恢复**可选的文件夹级共享工作区**：当用户为文件夹绑定目录（本地 FS 根或云端项目空间）时，该文件夹下所有对话读写同一文件目录（`folder:<folderId>`）；未绑定的文件夹仍只是 sidebar 分组，其下对话继续使用各自独立的 scratch（`conv:<conversationId>`）。改动量可控——Phase 1 刻意保留了 `locate.py` 的 `folder_id` 路径分支与 `workspaces.py` 的 `folder:` 解析，仅需在「文件夹已绑定」条件下恢复 Phase 1 去掉的传参路径。

---

## 2. 用户体验

### 2.1 绑定目录

| 方式 | 入口（建议） | 效果 |
|------|-------------|------|
| **本地** | 文件中枢 / 文件夹设置 →「绑定本地目录」；或创建文件夹时勾选「添加本地项目」 | 桌面 `fsApi.addRoot` 取得 `root_id`，写入 `folders.local_root_id`（+ 可选 `local_subpath`、`local_dir` 展示标签） |
| **云端** | 文件中枢 →「添加云项目」；或文件夹设置 →「启用共享工作区（云端）」 | 标记文件夹为云端共享项目，文件落在 `workspaces/<user_id>/<folder_id>/` |

绑定动作写在 **Folder** 行上，一次绑定对该文件夹下全部对话生效；**不**再为每个对话单独 bind（与 Phase 1 对话级 `PUT /conversations/{id}/workspace/binding` 互斥，见 §3.2）。

### 2.2 绑定后的对话体验

- 文件夹内**已有**与**新建**对话：Agent 写文件、面板上传、@ 索引、快照均指向 **同一** `folder:<folderId>` 空间（本地则同一 `local_root_id` + `local_subpath`）。
- 对话面板（`WorkspacePanel`）展示共享项目名（文件夹 `name`），文件列表与同文件夹其他对话一致。
- 同文件夹多对话并发写文件：`workspace_lock` 按 `workspace_storage_key(..., folder_id=<id>, ...)` 串行（`workspaces.py` 注释「Folder lock 决策④」沿用）。
- **未绑定**文件夹内的对话：行为与 Phase 1 相同，各自 `conv:<id>` scratch，互不可见。

### 2.3 移入 / 移出绑定文件夹

| 操作 | 文件行为 | 记忆（project scope） |
|------|----------|----------------------|
| 裸聊 / 未绑定文件夹 → **移入已绑定文件夹** | 此后读写 **共享目录**；原 `conv:<id>` scratch **保留在磁盘**，不再被该对话访问 | `folder_id` 生效 → project memory 注入（Phase 1 D4 方案 1，已落地） |
| **移出**已绑定文件夹 → 裸聊或未绑定文件夹 | 此后读写 **该对话自己的** `conv:<id>` scratch；共享目录中的文件 **不随对话带走** | project scope 随 `folder_id` 清空而关闭 |

产品上应提示：「移入共享项目后，将使用项目共用文件；原对话私有文件仍保留，可在文件中枢 `conv:<id>` 条目中查看」（若该 scratch 非空）。

### 2.4 文件中枢展示

`GET /v1/workspaces` 枚举两类条目（可并存）：

| `ws_id` | 名称 | 出现条件 |
|---------|------|----------|
| `folder:<folderId>` | 文件夹 `name` | 文件夹已绑定（§3.1）且（云端非空 **或** 本地已绑 `local_root_id`） |
| `conv:<conversationId>` | 对话 `title` | 对话**不在**已绑定文件夹内，且（有文件 **或** 有对话级本地绑定）——与 Phase 1 `list_workspaces` 逻辑相同 |

左栏建议按 **绑定文件夹 → 其下对话 scratch（若有）→ 裸聊 scratch** 分组；`folder:<id>` 段可折叠，展开后显示项目文件树（不再按对话标题拆行）。

---

## 3. 数据模型变更

### 3.1 Folder 表

Phase 1 **未删除** DB 列，仅停写 API；Phase 2 恢复语义如下。

| 字段 | Phase 1 状态 | Phase 2 语义 |
|------|-------------|-------------|
| `local_dir` | API 可读写，仅人类可读路径标签 | 保留；本地绑定时展示用 |
| `local_root_id` | DB 有列，路由/API 不暴露 | **本地绑定**时写入 desktop FS root handle；`NULL` = 非本地模式 |
| `local_subpath` | DB 有列，路由不暴露 | 容器根下的子路径；`NULL`/`""` = 根目录本身 |
| **新增** `workspace_bound` | — | `BOOLEAN NOT NULL DEFAULT false`：**云端**共享绑定的显式标记（本地绑定可由 `local_root_id IS NOT NULL` 推断，但建议绑定时同步置 `true` 以统一判断） |

**是否已绑定（共享工作区）**——单一判断函数（建议 `conversation/scratch.py` 或 `workspace/locate.py`）：

```python
def folder_has_shared_workspace(folder: Folder) -> bool:
    return folder.workspace_bound or bool(folder.local_root_id)
```

| `workspace_bound` | `local_root_id` | 判定 |
|-------------------|-----------------|------|
| false | NULL | 纯分组（Phase 1） |
| true | NULL | 云端共享项目 |
| true | 非 NULL | 本地共享项目 |
| false | 非 NULL | 视为本地共享（兼容迁移遗留行） |

**不新增** `workspace_kind` 枚举列——`location`（`cloud` / `local`）由 `local_root_id` 是否存在推导，与现有 `WorkspaceSummary.location` 一致。

**API Schema**（`api/schemas/conversations.py`）恢复/扩展：

| Schema | 变更 |
|--------|------|
| `CreateFolderRequest` | 可选 `local_root_id`（创建时一并本地绑定）；`workspace_bound: bool = false` |
| `UpdateFolderRequest` | 同上 + 支持清除绑定 |
| `FolderSummary` | 恢复 `local_root_id`、`local_subpath`（只读）；新增 `workspace_bound: bool` |
| `FolderGroup` | 同上 |

**新路由**（或恢复旧行为）：

- `PUT /v1/folders/{id}/workspace/binding` — body: `BindLocalWorkspaceRequest`（复用 `api/schemas/workspaces.py`）
- `DELETE /v1/folders/{id}/workspace/binding` — 清除本地绑定（`local_root_id`/`local_subpath`）；是否同时清 `workspace_bound` 由产品定（建议本地 unbind 后若也无云端标记则变回纯分组）
- `POST /v1/folders/{id}/workspace/bind-cloud` — 置 `workspace_bound=true`（幂等）

`FolderRepository`（`db/repositories/folders.py`）已有 `set_local_root_id`；需补 `set_workspace_bound`、`set_local_binding(root_id, subpath)` 并在 `create` / `update` 路由中重新接通。

### 3.2 对话的工作区选择逻辑

引入 **effective workspace** 解析（建议新函数 `resolve_conversation_workspace(conv, folder | None) -> WorkspaceTarget`）：

```python
@dataclass(frozen=True)
class WorkspaceTarget:
    folder_id: str | None      # 传给 locate / files / locks / snapshots
    conversation_id: str     # 恒为 conv.id（folder 路径分支忽略此段，但必填）
    ws_id: str                 # format_workspace_id(...)
    local_binding: LocalBinding | None
```

**规则**

| 条件 | `folder_id`（路径） | `ws_id` | `local_binding` 来源 |
|------|---------------------|---------|----------------------|
| `conv.folder_id` 为空 | `None` | `conv:<conv.id>` | `conv.local_root_id` / `local_subpath`（Phase 1） |
| 文件夹存在但未绑定 | `None` | `conv:<conv.id>` | 对话列（Phase 1） |
| 文件夹已绑定 | `folder.id` | `folder:<folder.id>` | **文件夹** `local_root_id` / `local_subpath`（恢复 `locate.resolve_local_binding` 语义） |

`format_workspace_id` / `_workspace_relpath`（`workspace/locate.py`）**无需改签名**——Phase 1 已保留 `folder_id` 非空 → `workspaces/<user>/<folder_id>/` 分支。

**对话级绑定与文件夹绑定互斥**（产品规则，须在 API 层校验）：

- 对话在**已绑定**文件夹内时：`PUT /conversations/{id}/workspace/binding` 返回 **409**（应改绑文件夹）。
- 对话移入已绑定文件夹时：**不**自动清除 `conv.local_root_id`（避免误删），但解析时 **文件夹绑定优先**；移出后若对话列仍有 binding 则恢复对话级本地 scratch。

**`build_turn_backend`**（`conversation/turn_backend.py`）——Phase 1 硬编码 `folder_id=None`，改为接收 `folder_id: str | None` 参数（由 `resolve_conversation_workspace` 填入）。

**`conversation/common.py::resolve_local_binding`**——改为：

1. 若 `conv.folder_id` 且文件夹 `folder_has_shared_workspace`：查 `FolderRepository.get_by_id_unscoped`，调 `locate.resolve_local_binding(folder_id=..., folder_local_root_id=folder.local_root_id, ...)`。
2. 否则：`scratch.resolve_conversation_local_binding(conv.local_root_id, conv.local_subpath)`（Phase 1 现状）。

---

## 4. 后端代码变更

基于 Phase 1 已落地代码，按模块列出**需在「文件夹已绑定」条件下恢复或扩展**的点。

### 4.1 核心解析（新增 / 扩展）

| 文件 | 改法 |
|------|------|
| `conversation/scratch.py` | 新增 `folder_has_shared_workspace`、`resolve_conversation_workspace`；导出供 routes / turns 共用 |
| `workspace/locate.py` | 取消 `resolve_local_binding` 的 deprecated 标记；模块顶注释改为「folder 绑定 → 共享路径」 |

### 4.2 回合与锁

| 文件 | Phase 1 现状 | Phase 2 改法 |
|------|-------------|-------------|
| `conversation/turn_backend.py` | `folder_id=None` 写死 | 参数化 `folder_id`，传入 `resolve_conversation_workspace` 结果 |
| `conversation/turns.py` | `workspace_lock(workspace_storage_key(..., folder_id=None, ...))` 两处；`run_and_persist(..., folder_id=folder_id)` 中 `folder_id` 仅用于 memory | `workspace_lock` / `build_turn_backend` 使用 **effective** `folder_id`；`run_and_persist` 的 `folder_id` 仍为 `conv.folder_id`（memory project scope，与路径解耦） |
| `conversation/turn_persistence.py` | `create_snapshot(..., folder_id=None, ...)` | 改为 effective `folder_id` |

### 4.3 对话文件 API

| 文件 | Phase 1 现状 | Phase 2 改法 |
|------|-------------|-------------|
| `api/routes/conversations/files.py` | 全部 `folder_id=None`；`_conv_workspace_lock` 同理 | 每路由先 `resolve_conversation_workspace`，传 effective `folder_id` |
| `api/routes/conversations/binding.py` | 仅对话列；`scope` 恒为 `"conversation"` | 已绑定文件夹内 409；`GET binding` 在共享时返回 `scope="folder"` + 文件夹 `root_id` |
| `api/routes/conversations/crud.py` | `move_conversation_to_folder` 注释「moving never changes scratch path」 | 更新注释与 OpenAPI；**不**迁移文件，仅切换 effective 路径（§2.3） |
| `api/routes/conversations/handoff.py` | `resolve_conversation_local_binding(conv 列)` | 改用 `resolve_conversation_workspace` |

### 4.4 工作区 API

| 文件 | Phase 1 现状 | Phase 2 改法 |
|------|-------------|-------------|
| `api/routes/workspaces.py` | `_resolve_owned_workspace` 已支持 `folder:`；`list_workspaces` **仅**枚举 `conv:` | `list_workspaces` 增加：遍历用户文件夹，`folder_has_shared_workspace` 且（本地 **或** `workspace_has_entries(..., folder_id=id, conversation_id="")`）→ 追加 `folder:<id>` 条目；避免纯分组空文件夹刷屏 |
| `api/schemas/workspaces.py` | `WorkspaceSummary` 无 `kind` | 可选加 `kind: Literal["scratch", "shared"]`（`conv:`→scratch，`folder:`→shared），便于前端分栏 |

### 4.5 Folder CRUD

| 文件 | Phase 1 现状 | Phase 2 改法 |
|------|-------------|-------------|
| `api/routes/folders.py` | `create` 仅 `name` + `local_dir` | 恢复 `local_root_id` 创建参数；新增 bind / unbind / bind-cloud 路由 |
| `db/repositories/folders.py` | `create` 仍接受 `local_root_id`；`set_local_root_id` 存在但未挂路由 | `update` 支持 `workspace_bound`；路由接通 |

### 4.6 其他

| 文件 | 说明 |
|------|------|
| `workspace/retention.py` | 软删文件夹时，若曾绑定，清理 `workspaces/<user>/<folder_id>/`（Phase 1 `permanent_delete` 已不 purge folder 空间） |
| `folders/permanent_delete.py` | 彻底删除绑定文件夹时，可选 purge 共享目录（需与产品确认） |
| `memory/*` | **无需改路径逻辑**——project scope 仍看 `conv.folder_id`（D4）；与 scratch 路径已解耦 |
| `scripts/migrate_folder_workspaces.py` | 见 §6 |
| 测试 | 恢复/改写 `tests/integration/test_workspace_binding_api.py`（仍测 promote 的用例应删或改为共享文件夹 bind）；新增 `test_shared_workspace.py`：同 folder 两对话写同一文件、移出后回到 conv scratch |

### 4.7 OpenAPI 链路

`scripts/dump_openapi.py` → `pnpm gen:api`（`api.mdc`）；**后端先部署**（`cursor-deploy.mdc`）。

---

## 5. 前端变更

### 5.1 Service / Hook

| 文件 | 改法 |
|------|------|
| `services/folders.ts` | `FolderMeta` 恢复 `localRootId` / `localSubpath` / `workspaceBound`；`bindFolderWorkspace` / `unbindFolderWorkspace` / `bindFolderCloud` |
| `hooks/useWorkspaces.ts` | 除 `conv:` 外识别 `folder:`；`useConversationWorkspace` 在对话位于绑定文件夹时返回 `folder:<folderId>` 条目 |
| `hooks/useFolders.ts` | 创建文件夹时可传本地绑定；invalidate workspace list |
| `services/workspaces.ts` | 类型对齐 `WorkspaceSummary.kind`（若有） |
| `services/sidecarRouting.ts` | `scratchFromWorkspaceCache` / `resolveLocalTarget`：对话在绑定文件夹时读 `folder:<folderId>` 缓存项的 `rootId`/`subpath`，而非 `conv:` |
| `components/files/fileWorkbench/storage.ts` | `folderIdOf` 去 deprecated，供 `folder:` 段使用；`conversationIdOf` 仅用于 `conv:` |

### 5.2 UI 组件

| 组件 | 改法 |
|------|------|
| `FileWorkbench.tsx` | 左栏增加 **共享项目**（`folder:`）段；与对话 scratch 段并列 |
| `WorkspaceSection.tsx` | 支持 `folder:` 标题（文件夹名 + 项目图标）；上下文菜单「在侧边栏打开文件夹」 |
| `WorkspacePanel.tsx` | 绑定文件夹内对话：source 解析为 `folder:<folderId>` |
| `WorkspaceGroupHeader.tsx` / `Sidebar.tsx` | 已绑定文件夹显示本地/云标记（读 `FolderMeta.localRootId` / `workspaceBound`） |
| `MessageInput` / `resolveAttachmentFolder.ts` | @ 附件源恢复 `workspace:folder:<id>` 前缀 |
| `components/chat/message-input/resolveAttachmentFolder.ts` | 注释「Folders no longer bind」需删除并恢复 folder 分支 |

### 5.3 交互恢复

- 文件中枢「添加本地项目 / 云项目」→ 创建或绑定文件夹，而非 promote 裸聊（Phase 1 已删 promote 链路，**不要**恢复）。
- 对话在共享项目内时，隐藏「为当前对话绑定本地目录」（或引导到文件夹设置）。

---

## 6. 数据迁移

### 6.1 Phase 1 迁移脚本实际行为

`scripts/migrate_folder_workspaces.py`：

- **单对话** auto-promote folder → 文件搬到 `conv/<id>/`，binding 写入对话列，folder 软删。
- **多对话** folder → 打印 `LEGACY: ... skipped (Phase 2)`，**不写 DB 标记**；文件仍在 `workspaces/<user>/<folder_id>/`，`folders.local_root_id` 等列保持原值。

### 6.2 Legacy 多对话 folder 接入

| 步骤 | 内容 |
|------|------|
| 1 | 新增 migration：`folders.workspace_bound BOOLEAN DEFAULT false` |
| 2 | 脚本 `scripts/activate_legacy_folder_workspaces.py`（建议）：对每个「多对话 + 未软删 + `workspaces/<user>/<folder_id>/` 非空或 `local_root_id` 非空」的 folder 设 `workspace_bound=true`（本地则保留 `local_root_id`） |
| 3 | **不搬文件**——路径已是 `folder_id` 分支目标，与 Phase 2 一致 |
| 4 | 成员对话 **不**清 `folder_id`（用户手动分组 + 共享文件并存） |
| 5 | 若某 legacy folder 已在 Phase 1 被误软删：靠备份恢复或手动归档，脚本 `--dry-run` 列清单 |

单对话 folder 若 migration 未跑完仍残留：重跑 Phase 1 脚本或手动并入 conv scratch，**不要**对其设 `workspace_bound`（避免与 conv 路径双写）。

### 6.3 对话 scratch 与共享目录共存

迁移后磁盘上可能同时存在：

- `workspaces/<user>/conv/<conv_id>/`（Phase 1 scratch）
- `workspaces/<user>/<folder_id>/`（legacy 共享）

Phase 2 **不自动合并**；用户在文件中枢可见两个条目，自行决定是否手动搬迁。

---

## 7. 实施步骤

| 顺序 | 步骤 | 验收 |
|------|------|------|
| 1 | DB migration：`workspace_bound` + schema 恢复 | 模型测试 |
| 2 | `resolve_conversation_workspace` + 单元测试（`test_workspace_locate.py` 扩展） | locate / format / parse 往返 |
| 3 | 后端核心：`turn_backend`、`turns`、`files`、`turn_persistence`、`common.resolve_local_binding` | integration：绑定 folder 下两对话写同一 path |
| 4 | Folder bind API + `workspaces.list_workspaces` 枚举 `folder:` | OpenAPI diff；`GET /v1/workspaces` 含共享项 |
| 5 | Legacy 激活脚本 dry-run → 执行 | 抽样 legacy 项目文件可读 |
| 6 | 前端：folders service → FileWorkbench / WorkspacePanel / sidecarRouting | `#/preview` + 手测本地 bind |
| 7 | 契约与测试：删改过时 promote 测试；`pnpm conformance` | CI 向量绿 |

**顺序**：后端（2→4）→ 迁移（5）→ 前端（6）；禁止先上前端（`cursor-deploy.mdc`）。

---

## 8. 开放问题

| # | 问题 | 选项 | 建议 |
|---|------|------|------|
| D1 | 云端绑定的 API 形态 | 独立 `bind-cloud` vs 创建文件夹时 `workspace_bound=true` | 两者都支持；创建空云项目即时可写 |
| D2 | 移入共享 folder 是否提示「放弃当前 scratch 可见性」 | 仅 toast vs 确认对话框 | 有 conv scratch 文件时强提示 |
| D3 | 对话级 `local_root_id` 与文件夹绑定并存时 | 文件夹优先 vs 移入时清空对话列 | **文件夹优先**（§3.2） |
| D4 | `permanent_delete` 绑定文件夹是否 purge `workspaces/<user>/<folder_id>/` | 保留 vs 删除 | 与对话 retention 对齐，默认软删保留、彻底删除 purge |
| D5 | `WorkspaceSummary.kind` 是否 Phase 2 必加 | 必加 vs 前端用 `ws_id` 前缀推断 | 必加，减少字符串解析分叉 |
| D6 | 未绑定文件夹是否显示「绑定目录」入口 | 仅文件中枢 vs 侧边栏文件夹菜单也有 | 两处都有，强调「升级为项目」 |
| D7 | 手机端 | 仅展示云 `folder:` vs 不做 | 手机无本地引擎，仅云共享只读/写 REST |

---

## 附录：Phase 1 保留、Phase 2 接通的代码锚点

| 能力 | 文件 | 说明 |
|------|------|------|
| 路径分叉 | `workspace/locate.py` `_workspace_relpath`、`format_workspace_id` | `folder_id` 非空 → `<user>/<folder_id>/` |
| ws 解析 | `api/routes/workspaces.py` `_resolve_owned_workspace` | `folder:` 分支已存在 |
| Folder 列 | `db/models/conversations.py` `Folder.local_root_id` 等 | 列未删 |
| Repo | `db/repositories/folders.py` `set_local_root_id` | 待挂路由 |
| 前端遗留 | `fileWorkbench/storage.ts` `folderIdOf` | 已标注 legacy，待激活 |

Phase 1 设计文档 §9 与 `folder-refactor-design.md` 迁移 §7.2 类型 A（多对话共享项目）为本 Phase 的直接前置。
