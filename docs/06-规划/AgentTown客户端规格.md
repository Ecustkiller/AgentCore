# AgentTown 客户端规格（Unity 独立应用 · 路线 B）

> **状态**：🗂️ 提案（2026-07-08 定案；审计结论同日并入）
> **决策**：观测层从 Desktop 内嵌 R3F **迁至 Unity 独立客户端**；**后端 `simulation/`、REST/SSE 契约、Postgres 落库不变**（非路线 C 全栈分叉）。
> **背景**：[AI 小镇 MVP 开发计划](AI小镇MVP开发计划.md) 原 R3F FE 路线接缝 bug 成本高；[多 AI 模拟愿景](../multi-ai-simulation-vision.md) 仍要求 3D Low-Poly 为卖点。
> **关联**：坐标契约 → `packages/protocol-conformance/fixtures/simulation-region-positions.json`；类型 → `packages/contract-types`、`apps/server/agentcore/simulation/types.py`

---

## 1. 产品定位

| 维度 | 定案 |
|------|------|
| 产品名（工作名） | **AgentTown**（Unity 可执行文件，如 `AgentTown.exe`） |
| 角色 | AgentCore **模拟观测客户端**——与 Desktop（协作/聊天）并列入口，**同一账号、同一后端** |
| 核心价值 | 「好看、能看的 3D AI 小镇」观看体验；手动 tick + 连续回放 |
| 主入口 | **直接启动 AgentTown**（独立安装包） |
| 副入口 | AgentCore Desktop「打开小镇」→ 启动子进程并传入 `--run-id` / token |
| 非目标 | 不重写 Python WorldEngine；不 fork 后端仓库；MVP 不做完整 OAuth 登录 UI |

**用户路径**

1. 直接启动 `AgentTown` → 读 token / 配置 API → 创建或恢复 run → 观看
2. Desktop 菜单「打开小镇」→ `AgentTown.exe --api … --token … [--run-id …]`

**M4 验收口径（与 MVP 对齐）**：「非技术用户可观看模拟」= 在 **AgentTown** 内完成观察 + 跟踪 + 回放；Desktop 仅作可选启动器，不再要求内嵌 3D 页。

---

## 2. 架构总览

```mermaid
flowchart TB
  subgraph town [apps/town Unity 2022.3 LTS]
    UI[UI Toolkit 观测面板]
    World[3D 场景 + NPC]
    Session[SimulationSession 单例]
    Rest[SimulationRestClient]
    Sse[SimulationSseClient]
    UI --> Session
    World --> Session
    Session --> Rest
    Session --> Sse
  end

  subgraph desktop [apps/desktop 保留]
    Launcher[打开小镇启动器]
    SessionFile[写 session.json]
    Launcher --> SessionFile
  end

  subgraph server [apps/server 现有]
    API["/v1/simulation/*"]
    Sim[SimulationService]
    DB[(sim_tick)]
    API --> Sim --> DB
  end

  Rest --> API
  Sse --> API
  SessionFile -.->|读 token| town
  Launcher -->|spawn| town
```

**铁律**

1. **模拟真相在后端**：tick 快照（`sim_tick`）为位置与 agent 状态的权威源。
2. **Unity 只消费契约**：REST + SSE；不内嵌 LLM、不本地推算 tick。
3. **单一客户端状态机**：`SimulationSession` 为唯一会话真相（禁止 React 式多 store）。
4. **Live / Replay 共用 `ApplySnapshot`**：差异仅在插值 vs 瞬移、是否处理 SSE 增量。
5. **坐标变换单点**：Wire 坐标（Three.js 右手系）→ Unity 左手系，仅在 `ApplySnapshot` 内变换（§6.2）。

---

## 3. 仓库布局

```
AgentCore/
├── apps/
│   ├── server/                      # 不动
│   ├── desktop/                     # 保留：启动器 + session.json 写入；R3F 退役
│   └── town/                        # Unity 2022.3 LTS
│       ├── Assets/
│       └── ProjectSettings/
├── packages/
│   ├── town-assets/                 # 3D 资产单一源（自 desktop/public 迁出或构建同步）
│   ├── contract-types/
│   └── protocol-conformance/fixtures/
│       ├── simulation-region-positions.json
│       └── simulation-m1-tick.json    # conformance 基线
```

**Desktop 保留（路线 B）**

| 组件 | 职责 |
|------|------|
| `session.json` 写入 | 用户登录后持久化 API 地址与 token（§8） |
| `/simulation/town` | Deprecated → 说明页 +「打开 AgentTown」按钮 |
| R3F `simulation/town/*` | Unity Phase 1 验收后删除；`?preview=1` 暂留至 Unity 离线模式就绪 |

**R3F 代码定位**：冻结为**对照实现**，不再新增功能；新需求只进 Unity。

---

## 4. SimulationSession 状态机

### 4.1 状态字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `runId` | string? | 当前 run |
| `scenario` | string | 默认 `"town"` |
| `tick` | int | run 尾部 tick |
| `hour` | int | 时钟显示 |
| `status` | enum | `active` \| `paused` \| `completed` |
| `mode` | enum | `Live` \| `Replay` |
| `playhead` | int? | `null` = live 尾部 |
| `playing` | bool | 自动连播 |
| `playbackSpeed` | float | 0.5 / 1 / 2 / 4 |
| `agents` | Map | UI + 3D 共用 |
| `tickCache` | Map\<tick, Snapshot\> | 客户端缓存 |
| `decisions` | List | `sim.agent_action`（最近 50） |
| `tickEvents` | List | 全事件（最近 400） |
| `manifest` | RunManifest? | **权威 roster**（`GET /manifest`） |
| `streamStatus` | enum | SSE 连接态 |
| `ticking` | bool | 等待 advance |
| `selectedAgentId` / `trackedAgentId` | string? | 选中 / 相机跟随 |

### 4.2 模式规则

| 条件 | SSE | 位置更新 |
|------|-----|----------|
| Live，`playhead == null` | 处理 `tick_started/ended`、`agent_*`、`interaction`、`world_event`；**忽略 `tick_frame`** | `tick_ended` 后 **仅** `GET /ticks/{n}` → `ApplySnapshot`；**不使用** `advance_tick` 响应内 snapshot 直接 apply |
| Replay 或 `playhead != null` | **忽略**改变世界状态的 SSE | **仅** `GET /ticks/{playhead}` → `ApplySnapshot`；NPC snap |
| `playing` | 同 Replay | 定时 `playhead++` → Seek |
| `playhead >= tick` | 切 Live | `GoLive()` + 拉最新帧 |

**Replay 数据源（定案）**：Phase 1–3 **仅** `GET /ticks/{n}` 逐帧拉取；**不用** `GET /replay` SSE（避免双路径）。

### 4.3 ApplySnapshot

1. 对每个 agent：`wirePos` → `unityPos = (x, y, -z)`（§6.2）
2. 合并 `manifest.personas` 的 `big_five`；bio 见 §6.4
3. Replay：`Transform.position = unityPos`；Live：`NavMeshAgent` 设目标
4. 纯视觉偏移 `spawnOffset`（§6.5）加在 Unity 侧，**不改** wire 坐标
5. 更新 UI、`tickCache`

---

## 5. REST API 映射

基址：`{apiBase}/v1/simulation`

| 动作 | 方法 | 路径 | Phase |
|------|------|------|-------|
| 创建 run | POST | `/runs` | P0 |
| 推进 tick | POST | `/runs/{id}/tick` | P0 |
| 读历史帧 | GET | `/runs/{id}/ticks/{n}` | P0 |
| Live SSE | GET | `/runs/{id}/stream` | P1 |
| **Manifest（roster 权威）** | GET | `/runs/{id}/manifest` | **P1** |
| 暂停/继续 | POST | `/runs/{id}/pause` \| `/resume` | P1 |
| 指标 | GET | `/runs/{id}/metrics` | P2 |
| 注入/改 agent | POST `/inject`、PATCH `/agents/{id}` | P3（对齐 MVP M3） |
| Run 列表 | GET | `/runs` | **中期后端增项**（BE-UT-01）；MVP 用本地历史 |

**POST /runs body**：`{ "scenario": "town", "seed?": int, "manifest?": object }`

**启用门禁**：`SIMULATION_ENABLED=true`

---

## 6. 数据契约

### 6.1 SimTickSnapshot

与 `agentcore.simulation.types.SimTickSnapshot` 一致（含 `tick_memories`、`governance`、`active_events`、`modifiers`、`metrics`）。C# DTO 手写对齐 OpenAPI。

### 6.2 坐标系（已定案）

| 空间 | 约定 |
|------|------|
| Wire / 后端 / fixture | 右手系 Y-up；`x` 东、`z` 南（注释见 `vec3.py`、`contract-types`） |
| Unity 场景 | 左手系 Y-up；**单点变换**：`unity = (wire.x, wire.y, -wire.z)` |

**验收**：`市场` wire `(24,0,0)` → Unity 世界坐标 `(24, 0, 0)`（Z 取反后落点与区域锚点一致）。须加 PlayMode 或单元测试读 `simulation-region-positions.json`。

> 后续可在 `contract-types` 注释改为「Wire 世界坐标（客户端自行映射至引擎坐标系）」。

### 6.3 区域锚点

单一源：`simulation-region-positions.json` → Unity `StreamingAssets` 或 Editor 导入。

7 区域：`广场`、`市场`、`餐厅`、`面包店`、`公园`、`住宅区`、`镇政厅`。

### 6.4 居民人设（已定案）

| 数据 | 权威源 |
|------|--------|
| `agent_id`、姓名、职业、`big_five`、regions | **`GET /runs/{id}/manifest`**（创建 run 后拉取） |
| `bio`、展示用关系文案 | 本地 `town-personas.json`（自 `townPersonas.ts` 导出）直至后端 manifest 补字段 |
| 运行时动态字段 | `SimTickSnapshot.agents` |

### 6.5 视觉偏移（非权威）

同区域多 NPC 防堆叠：Unity 侧 `spawnOffset` 表（对齐 Desktop `TOWN_SPAWN_OFFSET`），**仅影响渲染**，不参与后端位置回写。

### 6.6 SSE 事件处理

| 事件 | Live | Replay | 动作 |
|------|:----:|:------:|------|
| `sim.tick_started` | ✅ | ❌ | `ticking=true` |
| `sim.tick_ended` | ✅ | ❌ | `ticking=false`；`GET /ticks/{n}` → Apply |
| `sim.agent_action` | ✅ | ❌ | `pushDecision` |
| `sim.agent_state` | ✅ | ❌ | 更新 agent；Live 可预置 nav |
| `sim.interaction` | ✅ | ❌ | 事件流；3D 叠加 Phase 3 |
| `sim.world_event` | ✅ | ❌ | 事件流；修饰符 UI P2 |
| `sim.tick_frame` | **❌ 忽略** | 可选（仍优先 GET） | 避免与 tick_ended 双路径 |

### 6.7 契约漂移清单（已知，对齐责任）

| 项 | 现状 | 处理 |
|----|------|------|
| `sim.tick_started.agent_count` | fixture 有，TS 类型无 | Unity/C# 容忍可选字段 |
| `SimTickEndedPayload.metrics` | Python 有，TS 无 | Unity 读可选 `metrics` |
| Vec3 注释写 R3F | 历史遗留 | 改注释为 Wire 坐标 |

---

## 7. Unity 场景与 NPC

| 层 | 职责 |
|----|------|
| Bootstrap | 配置、认证、`SimulationSession` |
| TownScene | 地形、Kenney 建筑、NavMesh、区域锚点 |
| NpcLayer | `NavMeshAgent` + Animator；`agent_id` 与后端一致 |
| CameraRig | 鸟瞰 + 跟踪（Phase 2） |
| UiLayer | UI Toolkit 面板 |

**NPC 渲染（定案）**：单骨骼 GLB（`Xbot.glb`）**实例化** + 材质/标色区分居民（对齐现 Desktop，非每人独立 Mixamo 文件）。

**资产（定案）**：`packages/town-assets/` 为单一源；自 `apps/desktop/public/simulation/assets/` 迁出或 CI 同步脚本，避免双份手工维护。

**性能**：10 NPC ≥ 30 FPS（Windows 中端 GPU）。

**Unity 版本**：**2022.3 LTS**（团队统一）。

**平台**：Phase 1 **Windows**；macOS Phase 3。

---

## 8. 认证与配置（已定案）

### 8.1 Phase 0 Spike

- 开发环境：`Authorization: Bearer <access_token>`（手写 token 或 dev 登录复制）
- 启动参数：`--api <url> --token <token> [--run-id <id>]`

### 8.2 Phase 1+ Token 文件（Desktop 并行实现）

路径：`%APPDATA%/AgentCore/session.json`（macOS：`~/Library/Application Support/AgentCore/session.json`）

```json
{
  "api_base": "http://localhost:8000",
  "access_token": "<jwt or session token>",
  "refresh_token": "<optional>",
  "expires_at": "<ISO8601 optional>"
}
```

| 职责 | 方 |
|------|-----|
| 写入 | **Desktop** 登录成功后 |
| 读取 | **AgentTown** 启动时；Bearer 优先 |
| 401 | 尝试 refresh（若存在 `refresh_token`）；失败则提示打开 Desktop 登录 |

### 8.3 产品化（Phase 3）

- Unity 内嵌登录页 / 设备码 OAuth

---

## 9. Run 生命周期与本地历史

| 阶段 | 策略 |
|------|------|
| MVP | Unity `PlayerPrefs` / 本地 JSON 保存最近 12 个 run（对齐 Desktop `runHistory.ts` 语义）；支持 `--run-id` 恢复 |
| 中期 | 后端 **BE-UT-01**：`GET /v1/simulation/runs` 列表（用户维度） |
| 互通 | 可选读取同一 `agentcore:simulation-run-history` 键（低优先级） |

---

## 10. Desktop 启动器集成

| 项 | 定案 |
|----|------|
| UX | Desktop「打开小镇」→ `Process.Start(AgentTown.exe, args)` |
| 参数 | `--api {VITE_API_URL} --token {from session} [--run-id {current}]` |
| 路径发现 | 同目录 / `Program Files/AgentCore/AgentTown/` / 环境变量 `AGENTTOWN_PATH` |
| 错误 | 未找到 exe → 提示安装 AgentTown 独立包 |
| 深链 | Phase 2：`agenttown://open?run=…`；Phase 1 仅 CLI |

---

## 11. Desktop R3F → Unity 功能迁移对照

| Desktop 组件 | Unity Phase | 说明 |
|-------------|-------------|------|
| `TownCanvas` / `town/*` | P0–P1 | 3D 场景整体替换 |
| `SimulationRunManager` | P1 | Run 管理 UI |
| `TickControlBar` | P1 | 推 tick / pause |
| `SimulationPlaybackControls` | P1 | 回放、倍速、跳转 |
| `ResidentsPanel` | P1 | + manifest roster |
| `DecisionPanel` | P2 | |
| `EventTimelinePanel` | P2 | |
| `TrackingCamera` | P2 | |
| `ObservationPanel` + metrics | P2 | `GET /metrics` |
| `TownRegionHeatmap` | P2 | 区域情绪色块 |
| `TownLighting` / `dayNight` | P2 | 日夜光照 |
| `InteractionOverlays` | P3 | 对齐 MVP M3 |
| `GodModePanel` | P3 | inject / patch |
| `?preview=1` | 暂留 R3F | Unity 离线模式就绪后废弃 |

---

## 12. 测试与 Smoke

| 层级 | 门禁 |
|------|------|
| HTTP | 保留 `pnpm -C apps/desktop sim:smoke:e2e`（测 API+SSE，非 3D） |
| Conformance | C# 单测消费 `simulation-m1-tick.json` + region fixture |
| Unity | Phase 1：坐标 PlayMode；Phase 2：headless batch build |
| 渲染 | `shoot-simulation-town*.mjs` 退役后由 Unity 截图测试替代 |

---

## 13. 分阶段交付

### Phase 0 — Spike（~1 周）

- [ ] `apps/town` + Bearer 调通 create / tick / GET ticks/1
- [ ] 坐标变换 + 1 NPC 到 `市场`
- [ ] Desktop 并行：`session.json` 写入（最小实现）

### Phase 1 — 可观看 MVP（~2–3 周）

- [ ] 7 区域 + 10 NPC + Session 完整
- [ ] SSE live + GET 回放 + manifest
- [ ] Run 管理、Tick、居民列表
- [ ] 删 R3F `town/*`；Desktop 改启动器

### Phase 2 — 体验对齐（~2 周）

- [ ] 决策/事件/跟踪/热力/日夜/metrics
- [ ] Token 文件联调

### Phase 3 — 产品化

- [ ] 上帝模式 + 交互 3D 叠加（M3）
- [ ] Unity CI、Windows 安装包
- [ ] macOS 构建
- [ ] `sim.*` conformance 扩展

---

## 14. 验收标准（Phase 1）

1. 独立启动 AgentTown（token 文件或 CLI）
2. 创建 run → `GET /manifest` → 10 居民 roster 正确
3. 手动 5 tick；位置与 region fixture 一致（§6.2 变换后误差 < 0.5m）
4. 20 tick 回放 seek / 倍速，无 SSE 污染
5. 10 NPC ≥ 30 FPS（Windows）

---

## 15. 已定案决策摘要（2026-07-08）

| # | 决策 |
|---|------|
| 1 | 认证：Spike 用 Bearer；并行 Desktop 写 `session.json` |
| 2 | 坐标：wire → Unity `(x, y, -z)` 单点变换 |
| 3 | Roster：`GET /manifest` 权威；bio 本地 JSON 兜底 |
| 4 | Run 历史：本地缓存 + 中期 `GET /runs` |
| 5 | 主入口 AgentTown；Desktop 启动器副入口 |
| 6 | R3F 冻结对照，Phase 1 后删除 3D 代码 |
| 7 | 资产 `packages/town-assets` |
| 8 | Unity 2022.3 LTS；Windows 先行的 macOS 后 |
| 9 | Replay 仅 GET 逐帧；Live 忽略 `tick_frame` |
| 10 | MVP FE 任务映射为 UT-*（见 MVP 计划 §2.1） |

---

## 相关文档

- [AI 小镇 MVP 开发计划](AI小镇MVP开发计划.md)（§2.1 Unity 任务映射）
- [多 AI 模拟愿景](../multi-ai-simulation-vision.md)
- 后端 → `apps/server/agentcore/api/routes/simulation/runs.py`
