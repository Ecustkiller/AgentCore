# Folder 重构：纯分组 + 对话级文件空间

## 1. 目标

将 **Folder 从「项目容器 / 工作区」退化为纯对话分组**（类似邮件文件夹），用户手动创建与归类，不再承载文件读写、本地绑定、工作区枚举等职责。每个 **Conversation 自诞生起即拥有独立的轻量文件空间（Conversation Scratch）**——AI 或面板写文件时直接落入该对话自己的空间，**不触发 Folder 创建、不修改 `folder_id`**。同时 **删除 auto-promote 全链路**（`DeferredWorkspace`、`promote_bare_chat_to_folder`、`workspace_promoted` 事件等）。**共享工作区（Shared Workspace）** 作为 Phase 2 可选扩展，本次不实现，仅在数据模型与 API 层预留扩展点。

---

## 2. 当前模型（As-Is）

### 2.1 关系简图

```
┌─────────────────────────────────────────────────────────────────────────┐
│  心智模型：「文件夹 = 工作区」（文件夹即工作区）                          │
└─────────────────────────────────────────────────────────────────────────┘

User
 ├── Folder (folders 表)
 │     id, name
 │     local_dir          ← 展示用路径标签
 │     local_root_id      ← 本地模式绑定（desktop FS root handle）  ★ 即将移除/迁移
 │     local_subpath      ← 容器根下的 per-conversation 子目录     ★ 即将移除/迁移
 │     └── [0..N] Conversation.folder_id  → 同 folder 共享同一工作区目录
 │
 └── Conversation (conversations 表)
       id, title, folder_id (NULL = 裸聊)
       local_container_root_id  ← 裸聊首次写文件的本地容器根意图  ★ 语义将变更
       （无 conversation 级 local_root_id —— 已迁移到 folder，见 migration c7e1a9b3d5f8）

工作区存储路径 (workspace/locate.py `_workspace_relpath`):
  • folder_id 非空  →  workspaces/<user_id>/<folder_id>/
  • folder_id 为空  →  workspaces/<user_id>/conv/<conversation_id>/  （代码存在，但裸聊默认不可用）

工作区公共 id (format_workspace_id):
  • folder:<folder_id>  —— /v1/workspaces 唯一可解析种类
  • conv:<conversation_id>  —— 解析函数支持，但 workspaces.py 对 conv 种类返回 404

裸聊首次写文件 (auto-promote):
  Agent turn / 面板 upload / bind / clone
       → DeferredWorkspace._materialize()
       → promote_bare_chat_to_folder()
       → FolderRepository.create() + ConversationRepository.set_folder()
       → SSE workspace_promoted + hub 缓存 patch
```

### 2.2 关键字段（即将变化标注 ★）

| 实体 | 字段 | 当前语义 |
|------|------|----------|
| `Conversation` | `folder_id` | 分组 **且** 决定共享工作区目录 |
| `Conversation` | `local_container_root_id` | 裸聊 lazy promote 时的本地容器根 |
| `Folder` | `local_root_id` | 文件夹级本地绑定，子对话共享 |
| `Folder` | `local_subpath` | 懒建 per-conversation 本地子路径 |
| `Folder` | `local_dir` | 人类可读路径标签（文件中枢展示） |

### 2.3 Promote 触发点（当前）

| 路径 | 函数 / 路由 |
|------|-------------|
| Agent 回合首次写文件 | `turn_backend.build_turn_backend` → `DeferredWorkspace` → `bare_chat_promote` → `promote_bare_chat_to_folder` |
| 面板 creating op | `files._conv_write_folder` → `promote_bare_chat_to_folder` |
| 桌面面板本地意图 | `POST /v1/conversations/{id}/workspace/promote` + 前端 `createDeferredLocalSource` |
| 绑定本地目录 | `binding.bind_workspace` → `promote_conversation_folder`（裸聊时先 mint folder） |

### 2.4 附属约束（当前）

- **对话移动锁定**：`move_conversation_to_folder` 在 `message_count > 0` 时返回 409「对话开始后不可更换工作区」（`crud.py:268-269`）。
- **Memory project scope**：`folder_id` 即 `project_id`，存储于 `<user>/_folders/<folder_id>/`（`memory/store.py`）。
- **Sidecar 路由**：`sidecarRouting.ts` 经 `conversation.folderId` → `Folder.localRootId` + `localSubpath` 寻址。

---

## 3. 目标模型（To-Be）

### 3.1 关系简图

```
┌─────────────────────────────────────────────────────────────────────────┐
│  心智模型：Folder = 纯分组；Conversation = 自带 Scratch 文件空间          │
└─────────────────────────────────────────────────────────────────────────┘

User
 ├── Folder (folders 表) —— 仅 sidebar 分组
 │     id, name
 │     （移除 workspace 相关字段，或 Phase 1 标记 deprecated 只读）
 │     └── [0..N] Conversation.folder_id  → 仅影响列表归类，不影响文件路径
 │
 └── Conversation (conversations 表)
       id, title, folder_id (可选分组)
       scratch 绑定字段（见 §4.1）:
         local_root_id / local_subpath  或 演进 local_container_root_id
       └── Scratch 文件空间（始终存在，lazy 创建目录，不 lazy 创建 folder）

工作区存储路径（统一 per-conversation）:
  Cloud  →  workspaces/<user_id>/conv/<conversation_id>/
  Local  →  desktop: <container_root>/<subpath>/  （绑定在 conversation 上）

工作区公共 id:
  conv:<conversation_id>  —— 一等公民；文件中枢 / 面板 / @ 索引均按对话空间寻址
  folder:<folder_id>      —— Phase 2 共享工作区预留；Phase 1 不再枚举

写文件流程（无 promote）:
  Agent turn / 面板 op
       → build_server_workspace(folder_id=None, conversation_id=...)
       或 build_local_workspace(conversation 级 LocalBinding)
       → 直接读写 conv scratch；folder_id 不变
```

### 3.2 行为变更摘要

| 行为 | As-Is | To-Be |
|------|-------|-------|
| 裸聊首次写文件 | 自动创建 Folder + 设置 `folder_id` | 写入 `conv:<id>` scratch，**不**改 `folder_id` |
| 移入/移出 Folder | 未发消息可移；已发消息 409 | **随时可移**（仅分组） |
| 文件中枢 rail | 枚举 `folder:*` 工作区 | 枚举 `conv:*`（有文件的对话空间）；Folder 仅 sidebar |
| 本地 sidecar | 经 Folder 绑定 | 经 **Conversation** scratch 绑定 |
| `workspace_promoted` SSE | 有 | **删除** |

---

## 4. 数据模型变更

### 4.1 Conversation 表

**新增字段（✅ 已定：方案 A，见 D1）**

| 方案 | 字段 | 说明 |
|------|------|------|
| A（✅ 已定） | `local_root_id: String(200) \| NULL` | 从 Folder 下沉：该对话 scratch 的 desktop FS root |
| A | `local_subpath: String(400) \| NULL` | 容器根下子目录；`""` = 直接用 root |
| B（已否决） | 复用 `local_container_root_id` | 保留现有列作 root；**新增** `local_subpath` |

**修改字段**

| 字段 | 变更 |
|------|------|
| `folder_id` | 语义收窄为**纯分组**；移动不再触发工作区路径变化 |
| `local_container_root_id` | **废弃**（迁移后 drop；见 D1 方案 A） |

**移除 / 不再写入**

- 无新 DB 列需删；promote 不再调用 `set_folder` 写 workspace 目的。

**Per-conversation file space 存储策略**

| 模式 | 路径规则 | 真相源 |
|------|----------|--------|
| Cloud | `{data_dir}/workspaces/{user_id}/conv/{conversation_id}/` | 服务端 `ServerWorkspace`（已有 `_workspace_relpath` 分支） |
| Local | desktop `local_root_id` + `local_subpath`（对话级） | 用户机器；经 `WorkspaceChannel` / sidecar IPC |
| Snapshot | `workspace_storage_key(..., folder_id=None, conversation_id=<id>)` → `workspaces/{user_id}/conv/{conversation_id}` | 对象存储；与路径规则一致 |

**Lazy 创建**：目录在首次写操作时 `mkdir`（`resolve_workspace_root`），**不**创建 Folder 行。

### 4.2 Folder 表

**Phase 1 保留（分组必需）**

- `id`, `user_id`, `name`, `created_at`, `updated_at`, `deleted_at`

**移除或 deprecated（workspace 职责剥离）**

| 字段 | 处理建议 |
|------|----------|
| `local_dir` | Phase 1 **移除** API 读写；DB 列可保留 NULL 待迁移脚本清空 |
| `local_root_id` | 迁移：见 §7；列 Phase 1 停止写入，Phase 2 前 drop |
| `local_subpath` | 同上 |

**`FolderRepository.create`**

- 移除 `local_root_id` / `local_subpath` 参数（`folders.py:19-40`）。
- 移除 `set_local_root_id` 的对外路由用途（绑定改到 conversation）。

### 4.3 API Schema 变更

**`api/schemas/conversations.py`**

| Schema | 变更 |
|--------|------|
| `CreateConversationRequest` | 保留 `folder_id`（分组）；`local_container_root_id` → 重命名或保留为 scratch 本地 root 意图 |
| `ConversationSummary` | 更新注释：`folder_id` 不再暗示 workspace；新增 `has_files` 或 `scratch_location` **（待决策：是否在 list 中带 scratch 摘要）** |
| `CreateFolderRequest` | **移除** `local_root_id`（「添加本地项目」改 Phase 2 或改走 conversation） |
| `FolderSummary` | **移除** `local_root_id`, `local_subpath` |
| `FolderGroup` | 同上 |

**`api/schemas/workspaces.py`**

| Schema | 变更 |
|--------|------|
| `WorkspaceSummary` | `ws_id` 以 `conv:<id>` 为主；`folder:<id>` Phase 1 不再列出 |
| `WorkspaceBindingResponse` | `scope` 固定为 `"conversation"`；binding 读 conversation 列 |
| `BindLocalWorkspaceRequest` | 仍绑定 **conversation** scratch，不再 mint folder |

**删除的 response**

- `POST /v1/conversations/{id}/workspace/promote` → `FolderSummary`（整路由删除）

**OpenAPI 刷新链路**

- `scripts/dump_openapi.py` → `pnpm gen:api`（`api.mdc` 规范）

---

## 5. 代码变更清单

### 5.1 删除 / 废弃

| 模块 | 内容 |
|------|------|
| `conversation/promotion.py` | 整文件：`promote_bare_chat_to_folder`, `promote_conversation_folder`, `bare_chat_promote`, `_broadcast_promotion`, `_sanitize_subpath_segment`, `_unique_local_subpath` |
| `workspace/deferred.py` | 整文件：`DeferredWorkspace`, `PromotionResult`, `PromoteFn` |
| `conversation/turn_backend.py` | `DeferredWorkspace` 分支；裸聊直接 `build_workspace(folder_id=None, ...)` |
| `api/routes/conversations/files.py` | `_conv_write_folder`, `_promoted_workspace`, `promote_workspace` 路由 |
| `api/routes/conversations/binding.py` | `promote_conversation_folder` 调用；裸聊 bind 改为只写 conversation 列 |
| `runtime/events/workspace.py` | `workspace_promoted` 事件构造 |
| `runtime/events/__init__.py` | 导出移除 |
| `conversation/service.py` | 对 `promotion` 的 re-export |
| 测试 | `test_workspace_symmetry.py` promote 段、`integration/test_workspace_api.py::test_promote_bare_chat_workspace` 等 |
| 前端 | `services/folders.ts::promoteConversationWorkspace` |
| 前端 | `services/sources/deferredLocalSource.ts` |
| 前端 | `services/workspacePromotion.ts` |
| 前端 | `services/sse/handlers/workspace.ts` 中 `workspace_promoted` case |
| 前端 | `services/realtime.ts` 中 `workspace_promoted` 处理 |
| 契约 | `packages/contract-types/src/events.ts` 中 `workspace_promoted` |
| 手机 | `apps/mobile/src/protocol/fold.ts`、`parity.ts` 中 `workspace_promoted` case |

### 5.2 修改

| 模块 | 改法 |
|------|------|
| `workspace/locate.py` | **`resolve_local_binding`**：改为读 conversation 的 `local_root_id`/`local_subpath`，不再读 folder；**`build_turn_backend` 调用方** 传 conversation 绑定 |
| `workspace/locate.py` | **`default_workspace_name`**：仅 Phase 2 / 迁移脚本使用，或删除 |
| `conversation/common.py` | `resolve_local_binding(session, conv)` 从 conv 列解析，不再查 Folder |
| `conversation/turns.py` | `workspace_lock` key 恒为 `folder_id=None, conversation_id=<id>`；去掉 promote 后 `folder_id` 仅用于 memory injection |
| `conversation/turn_persistence.py` | 快照：`snapshot_folder_id = None`，`conversation_id` 必填 |
| `api/routes/conversations/files.py` | 所有 op 直接用 `conv.id` scratch；去掉 promote；裸聊 list 可读 conv 目录（非空时） |
| `api/routes/workspaces.py` | `_resolve_owned_workspace`：**支持 `conv:`**；`list_workspaces` 枚举有文件的 conversation scratch（`workspace_has_entries(..., folder_id=None, conversation_id=...)`） |
| `api/routes/conversations/crud.py` | `move_conversation_to_folder`：**删除** message_count 409 守卫 |
| `api/routes/folders.py` | `create_folder` 不再接收 `local_root_id`；`permanent_delete` **仅解除分组**，不删成员对话（见 D5） |
| `folders/permanent_delete.py` | 不再 `purge_folder_space`（folder 无独立空间）；成员对话按对话 retention 处理 |
| `db/repositories/folders.py` | 精简 create/update |
| `db/repositories/conversations.py` | 新增 `set_local_binding(conversation_id, root_id, subpath)` |
| `workspace/retention.py` | 按 conv scratch 清理；folder 级 purge 改为迁移脚本 |
| `memory/consolidation.py` | `project_id = conv.folder_id` 仅当用户手动分组时启用（见 D4 方案 1 / §8.2） |
| `memory/injection.py` | project layer 注入条件变更 |
| `memory/store.py` | `project_scopes` 枚举逻辑变更 |
| 前端 `useWorkspaces.ts` | `useConversationWorkspace` 映射 `conv:<conversationId>` 而非 `folder:<folderId>` |
| 前端 `useWorkspaces.ts` | `addWorkspaceFromFolder` → `addConversationScratch` 或按 conv 投影 |
| 前端 `sidecarRouting.ts` | 从 conversation scratch 字段解析 `SidecarTarget` |
| 前端 `WorkspacePanel.tsx` | 移除 `createDeferredLocalSource` 分支 |
| 前端 `FileWorkbench.tsx` | rail 展示 conv scratch；Folder CRUD 与 workspace 解耦 |
| 前端 `ConversationItem.tsx` | 移除 `workspaceLocked` 对移动的限制 |
| 前端 `components/files/fileWorkbench/WorkspaceSection.tsx` | 适配 `conv:` id |
| 手机端 | 同步 fold / 无 promote 事件 |

### 5.3 新增

| 模块 | 说明 |
|------|------|
| DB migration | 添加 conversation.local_root_id / local_subpath；数据迁移脚本（§7） |
| `scripts/migrate_folder_workspaces.py`（建议路径） | 一次性：folder 工作区 → conv scratch 文件搬迁 + 元数据重写 |
| `conversation/scratch.py`（建议路径） | 封装 scratch 路径解析、`ensure_scratch_workspace(conv)` |
| 前端 `services/scratchWorkspace.ts`（建议路径） | `convId → wsId`  helper、`getConversationScratch(conversationId)` |
| 测试 | `test_conv_scratch.py`：裸聊写文件不创建 folder；移动分组不影响路径 |

---

## 6. 前端变更

### 6.1 Store / Service 变更

| 文件 | 变更 |
|------|------|
| `services/folders.ts` | 删除 `promoteConversationWorkspace`；`FolderMeta` 去掉 `localRootId`/`localSubpath` |
| `services/workspaces.ts` | 注释更新：`ws_id` 以 `conv:` 为主 |
| `services/workspacePromotion.ts` | **删除文件** |
| `services/sources/deferredLocalSource.ts` | **删除**；本地裸聊直接用 `createLocalRootSource` + conversation subpath |
| `services/sources/workspaceSource.ts` | `resolveWorkspaceSource` 按 `conv:<id>` |
| `hooks/useWorkspaces.ts` | 见 §5.2 |
| `hooks/useFolders.ts` | 删除 `addWorkspaceFromFolder` 联动（或改为 conv 维度） |
| `stores/conversation/types.ts` | 移除 `workspace_promoted` 相关注释/字段 |

### 6.2 UI 组件变更

| 组件 | 变更 |
|------|------|
| `WorkspacePanel.tsx` | 始终绑定当前 `conversationId` 的 scratch；无 promote 中间态 |
| `FileWorkbench.tsx` | 左栏按 **对话空间** 分组展示（名称用 conversation.title）；Folder 操作退回 `/conversations` sidebar |
| `Sidebar.tsx` / `ConversationItem.tsx` | 文件夹仅筛选/拖拽分组；**解除**「对话开始后不可移动」UI 禁用 |
| `MessageInput` / `useComposerSend.ts` | 仍传 `local_container_root_id`（或新字段）作 scratch 本地意图 |
| `FileWorkbench`「添加本地文件夹」 | **待决策**：Phase 1 隐藏或改为「为当前对话绑定本地目录」 |

### 6.3 删除的交互

- 裸聊首次写文件后 sidebar **自动出现新 Folder 卡片**
- 文件中枢 rail **自动新增** promote 出来的 workspace 行（`applyConversationPromotion` 三处缓存 patch）
- `workspace_promoted` 实时 re-group 动画/逻辑
- 对话移动菜单里的「工作区已锁定」提示（`ConversationItem.tsx:214-246`）
- `POST .../workspace/promote` 手动 promote 入口

---

## 7. 数据迁移方案

### 7.1 现有数据分类

| 类型 | 识别方式 | 文件位置 |
|------|----------|----------|
| A. 用户手动创建的 Folder 项目 | `folders.local_root_id` 非空 且 多对话共享 **或** 用户通过「添加文件夹」创建 | `workspaces/<user>/<folder_id>/` |
| B. Auto-promote 裸聊 | `folders.local_subpath` 非空 **或** folder 内仅 1 对话且 folder 名≈对话 title | 同上或 local subpath |
| C. Cloud promote 裸聊 | folder 无 local_root_id，单对话 | `workspaces/<user>/<folder_id>/` |
| D. 从未写文件的裸聊 | 无 folder，无磁盘目录 | 无迁移 |
| E. 已在 conv 路径的遗留 | `workspaces/<user>/conv/<id>/` 非空 | 已是目标形态 |

### 7.2 迁移策略（建议）

**B + C（auto-promote folder，单对话）—— 主路径（✅ D3：删除 folder 行）**

1. 对每个仅含 1 个 conversation 的 promote folder：
   - 将 `workspaces/<user>/<folder_id>/` **移动或复制**到 `workspaces/<user>/conv/<conversation_id>/`
   - 若 folder 有 `local_root_id`/`local_subpath`：写入 conversation 的 scratch 绑定列
   - **`conversations.folder_id` 置 NULL**（对话变回裸聊；该 folder 仅为 promote 副作用，非用户分组意图）
   - **删除**该 folder 行（soft-delete）
2. 快照 object-store key：按 `workspace_storage_key` 规则重写或保留双读 **（待决策，见 D8）**

**A（真正的多对话共享项目）—— ✅ 已定：推迟 Phase 2，标记 legacy（见 D2）**

- Phase 1：迁移脚本仅标记 `legacy_folder_workspace=true`，不搬迁文件；保持旧 `workspaces/<user>/<folder_id>/` 路径只读
- Phase 2：Shared Workspace 实体接管多对话共享（见 §9）
- 已否决：拆分 per-conversation 副本、挂主对话只读链接

**Memory project 层（✅ D4：方案 1）**

- 用户**手动** Folder 继续作为 project scope；auto-promote folder 删除时，其 `_folders/<folder_id>/` memory **合并到 global**

### 7.3 裸聊处理

- 无 folder、无文件：零操作
- 有 folder（promote 产物）但用户未手动分组：按 7.2 主路径合并到 conv scratch 并清理 folder

### 7.4 回滚计划

1. 迁移前：**全量备份** `{data_dir}/workspaces/` 与 DB snapshot
2. 迁移脚本 `--dry-run` 输出搬迁清单
3. Feature flag `FOLDER_REFACTOR_SCRATCH=1` 控制新路径解析；关闭则回退旧代码（迁移后回滚需反向搬迁，**仅在 dry-run 未 destructive 时可行**）
4. 保留 30 天 orphan `folder_id` 目录只读归档，确认无访问后删除

---

## 8. Memory 系统影响

### 8.1 当前耦合

- `MemoryExtractInput.project_id` = `conv.folder_id`（`consolidation.py:95-127`）
- `MemoryOp.scope`：`folder_id` 字符串 = project layer（`user_memory.py:94-103`）
- 存储路径：`<base>/<user_id>/_folders/<folder_id>/`（`store.py:143-145`）
- 注入：`injection.py` 在 `folder_id`  truthy 时加载 project profile + topics

### 8.2 适配方案

| 方案 | 说明 |
|------|------|
| **方案 1（推荐 Phase 1）** | **Project scope 仍用 `folder_id`**，但仅当用户**手动**把对话放进 Folder 时启用；裸聊 / 仅 promote 的 folder **不**写 project memory |
| **方案 2** | 新增 `conversation_id` scope；project 改指「手动 Folder 分组 id」与 memory 解耦 |
| **方案 3** | Phase 1 取消 project layer，全部 global **（损失大，不推荐）** |

**✅ 已定（D4：方案 1）**：用户**手动** Folder 继续作为 project memory 作用域；裸聊 / 仅 promote 的 folder **不**写 project memory。`folder_id` 保留 memory 语义，但与 scratch 路径解耦（**分组即作用域**）。

**迁移**：auto-promote folder 删除时，其 `_folders/<folder_id>/` memory **合并到 global**（promote 产物非用户手动分组，不适用 project scope）。

---

## 9. 实施阶段

### Phase 1（本次）

| 步骤 | 内容 | 验收 |
|------|------|------|
| 1. 后端模型 | migration 添加 conversation scratch 列；Folder workspace 列停写 | 单元测试 locate / storage_key |
| 2. 后端逻辑 | 删除 promote + DeferredWorkspace；turn/files 走 conv scratch | integration: 裸聊 write 不创建 folder |
| 3. 后端 API | workspaces 列出 `conv:`；删除 promote 路由；move 去掉 409 | OpenAPI diff |
| 4. 迁移脚本 | 7.2 主路径 dry-run + 执行 | 抽样对话文件可读 |
| 5. 前端 | 面板 / hub / sidecar 切 conv scratch；删 promote 缓存 | `#/preview` 向量 + 手测写文件 |
| 6. Memory | 按 §8 选定方案调整 consolidation / injection | memory 测试 |
| 7. 契约 | 删 `workspace_promoted`；`pnpm conformance` | 桌面 + 手机 fold 绿 |

**顺序**：后端（2→3）→ 迁移（4）→ 前端（5）→ Memory（6）；**禁止**先上前端后上后端（`cursor-deploy.mdc`）。

### Phase 2 扩展点预留

- **Shared Workspace** 实体（或复用 Folder 名但新表）：多 conversation 共享同一 `shared:<id>` 路径
- `WorkspaceSummary` 增加 `kind: "scratch" | "shared"`
- 文件中枢可选「挂载共享项目」入口，与 sidebar Folder 分组独立
- API：`POST /v1/shared-workspaces` **（仅预留，不实现）**

---

## 10. 风险与决策点

| # | 问题 | 选项 | 状态 |
|---|------|------|------|
| D1 | Conversation 本地绑定字段命名 | 方案 A 新列 vs 方案 B 复用 `local_container_root_id` | **✅ 已定：方案 A** |
| D2 | 多对话共享的旧 Folder 项目如何迁移 | 拆分 / 延迟 Phase 2 / 只读 legacy | **✅ 已定：Phase 2 处理，标记 legacy** |
| D3 | Auto-promote folder 是否保留为 sidebar 分组 | 删除 folder 行 vs 保留空分组 | **✅ 已定：删除 folder 行** |
| D4 | Memory project scope 是否仍绑定手动 Folder | 方案 1 / 2 / 3（§8.2） | **✅ 已定：方案 1** |
| D5 | `permanent_delete_folder` 是否仍删除成员对话 | 当前会 hard-delete 全部成员 | **✅ 已定：仅解除分组** |
| D6 | 文件中枢「添加本地文件夹」Phase 1 行为 | 隐藏 / 改为对话级绑定 / 占位 | **待决策** |
| D7 | `ConversationSummary` 是否暴露 scratch 摘要字段 | 便于 sidebar 显示「有文件」角标 | **待决策** |
| D8 | 快照 object-store key 迁移策略 | 重写 key vs 双读兼容 | **待决策** |

### 风险

| 风险 | 缓解 |
|------|------|
| 迁移遗漏导致文件「找不到」 | dry-run 清单 + 保留 orphan 目录 30 天 |
| 桌面 local subpath 与云路径不一致 | 单一 `scratch.py` 解析；sidecar 与 REST 同测 |
| Memory project 错层 | 迁移后跑 consolidation 回归向量 |
| 并行 worktree 冲突 | 按 `dev-process.mdc` 后端先部署；OpenAPI 单 PR 串行 |

---

## 附录：关键文件索引

| 领域 | 路径 |
|------|------|
| DB 模型 | `apps/server/agentcore/db/models/conversations.py` |
| Promote | `apps/server/agentcore/conversation/promotion.py` |
| Deferred | `apps/server/agentcore/workspace/deferred.py` |
| 路径解析 | `apps/server/agentcore/workspace/locate.py` |
| 对话文件 API | `apps/server/agentcore/api/routes/conversations/files.py` |
| 工作区 API | `apps/server/agentcore/api/routes/workspaces.py` |
| Folder CRUD | `apps/server/agentcore/api/routes/folders.py` |
| 移动守卫 | `apps/server/agentcore/api/routes/conversations/crud.py` |
| Memory | `apps/server/agentcore/memory/user_memory.py`, `store.py`, `consolidation.py` |
| 前端 promote | `apps/desktop/src/renderer/services/workspacePromotion.ts` |
| 前端 deferred | `apps/desktop/src/renderer/services/sources/deferredLocalSource.ts` |
