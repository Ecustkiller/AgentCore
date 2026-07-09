# AgentTown 客户端规格（Unity 6 LTS 独立应用 · 路线 B）

> **状态**：**Unity 客户端为新目标（规格 / 待移植）——尚未落地**。本文以 Unity 6 LTS + URP + C# 定义目标客户端；现有 `apps/town` 的 **Unreal Engine 5.8 Phase 0 + Phase 1 代码降级为「将退役的参照实现」**（比照 Desktop R3F 冻结→删除先例），Unity 达 Phase 1 parity 后删除。**不得**把 Unity 客户端当作已落地。落地结论后续按 doc-governance 迁入 `docs/01`–`05`。
> **决策（2026-07-08）**：AI 小镇观测客户端由 **Unreal Engine 5.8 改为 Unity 6 LTS + URP + C#**（Low-Poly 低模）；产品名保持 **AgentTown**，路径仍为 `apps/town/`。**决定性理由**：中期已确认要做 **Web 传播版**，而 UE **无原生 Web 导出**，**Unity 原生 WebGL2**。迁移低风险依据：`apps/town` 现有实现**无任何 `.uasset`**（7 区域场景全部运行时代码生成），且客户端逻辑已有**两份参照实现**（Desktop R3F TypeScript + 现有 UE C++），Unity C# 属「照蓝图翻译」。详见 §15「从 UE 迁移」。
> **不变量**：**后端 `simulation/`、REST/SSE 契约、Postgres 四表、`packages/protocol-conformance` fixtures 全部复用、零改动**（非路线 C 全栈分叉）。
> **开发口径**：单人开发者 + 全程 AI 辅助。
> **背景**：[AI 小镇 MVP 开发计划](AI小镇MVP开发计划.md) 原 R3F FE 路线接缝 bug 成本高；产品方定案画面为长期卖点，且需 Web 传播版触达非安装用户。
> **关联**：坐标契约 → `packages/protocol-conformance/fixtures/simulation-region-positions.json`；类型 → `packages/contract-types`、`apps/server/agentcore/simulation/types.py`

---

## 1. 产品定位

| 维度 | 定案 |
|------|------|
| 产品名（工作名） | **AgentTown**（Unity 打包产物：Phase 1 Windows `AgentTown.exe`；**中期 WebGL 传播版**——浏览器直达、无需安装） |
| 引擎 | **Unity 6 LTS + URP + C#**（Low-Poly 低模） |
| 角色 | AgentCore **模拟观测客户端**——与 Desktop（协作/聊天）并列入口，**同一账号、同一后端** |
| 核心价值 | 「好看、能看的 3D AI 小镇」观看体验；手动 tick + 连续回放 |
| 主入口 | **直接启动 AgentTown**（独立安装包 / WebGL 页面） |
| 副入口 | AgentCore Desktop「打开小镇」→ 启动子进程并传入 `--run-id` / token |
| 非目标 | 不重写 Python WorldEngine；不 fork 后端仓库；MVP 不做完整 OAuth 登录 UI |

**用户路径**

1. 直接启动 `AgentTown` → 读 token / 配置 API → 创建或恢复 run → 观看
2. Desktop 菜单「打开小镇」→ `AgentTown.exe --api … --token … [--run-id …]`
3. （中期）浏览器打开 WebGL 传播版 → URL query / 同源会话取 token → 观看

**M4 验收口径（与 MVP 对齐）**：「非技术用户可观看模拟」= 在 **AgentTown** 内完成观察 + 跟踪 + 回放；Desktop 仅作可选启动器，不再要求内嵌 3D 页。

---

## 2. 架构总览

```mermaid
flowchart TB
  subgraph town [apps/town Unity 6 LTS + URP]
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
5. **坐标变换单点**：Wire 坐标（Y-up 右手系，x 东、z 南）→ Unity Y-up 左手系，仅在 `ApplySnapshot` 内变换（§6.2）。

---

## 3. 仓库布局

**目标 Unity 布局**（`apps/town` 由 UE 工程原地替换为 Unity 工程；退役前两者不并存超过 Phase 1）：

```
AgentCore/
├── apps/
│   ├── server/                      # 不动
│   ├── desktop/                     # 保留：启动器 + session.json 写入；R3F 退役
│   └── town/                        # Unity 6 LTS + URP（替换现有 UE 工程）
│       ├── Assets/
│       │   ├── Scripts/             # C# SimulationSession、REST、SSE、坐标
│       │   ├── Scenes/             # Town.unity（空场景 + 运行时建镇）
│       │   ├── Prefabs/            # NPC / 建筑预制体
│       │   ├── UI/                  # UI Toolkit UXML/USS
│       │   └── StreamingAssets/Fixtures/   # fixture 同步副本（region/m1-tick）
│       ├── Packages/manifest.json   # URP、AI Navigation、Newtonsoft.Json 等 UPM 依赖
│       └── ProjectSettings/
├── packages/
│   ├── town-assets/                 # 3D 资产单一源（自 desktop/public 迁出或构建同步）
│   ├── contract-types/
│   └── protocol-conformance/fixtures/
│       ├── simulation-region-positions.json
│       └── simulation-m1-tick.json    # conformance 基线
```

**无 `.uasset` / 无 `Content/`**：场景与建筑全部**运行时代码生成**（照译 R3F `regionLayout.ts` + UE spawner），资产以 FBX/glTF 从 `packages/town-assets` 导入 `Assets/`。

**Desktop 保留（路线 B）**

| 组件 | 职责 |
|------|------|
| `session.json` 写入 | 用户登录后持久化 API 地址与 token（§8） |
| `/simulation/town` | Deprecated → 说明页 +「打开 AgentTown」按钮 |
| R3F `simulation/town/*` | Unity Phase 1 parity 后删除；`?preview=1` 暂留至 Unity 离线模式就绪 |

**双参照实现定位**：Desktop R3F（TypeScript）与现有 UE C++ **均冻结为对照实现**，不再新增功能；新需求只进 Unity。UE 工程在 Unity 达 Phase 1 parity 后删除（§15）。

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

1. 对每个 agent：`wirePos` → `unityPos = (wire.x, wire.y, -wire.z)`（§6.2）
2. 合并 `manifest.personas` 的 `big_five`；bio 见 §6.4
3. Replay：`Transform.position` 瞬移；Live：`NavMeshAgent.SetDestination` 设目标
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

与 `agentcore.simulation.types.SimTickSnapshot` 一致（含 `tick_memories`、`governance`、`active_events`、`modifiers`、`metrics`）。C# DTO class + `Newtonsoft.Json`（`com.unity.nuget.newtonsoft-json`，处理字典/嵌套/可选字段）手写对齐 OpenAPI。

### 6.2 坐标系（已定案 · Unity）

| 空间 | 约定 |
|------|------|
| Wire / 后端 / fixture | **Y-up 右手系**；`x` 东、`z` 南、`y` 上（注释见 `vec3.py`、`contract-types`） |
| Unity 场景 | **Y-up 左手系**；**单点变换**（世界比例 `S = 1`，1 wire 单位 = 1 米 = 1 Unity 单位——Unity 基础单位即米，无需 ×100）：`unity = (wire.x, wire.y, -wire.z) × S` → `Vector3(x, y, z)`。 |

**推导**：wire 与 Unity 同为 Y-up，故「上」轴（`y`）直传；两者手性不同（wire 右手、Unity 左手），须**恰翻一个轴**以避免镜像——按 glTF/Three.js→Unity 标准约定**翻 `z`**（wire 的 `+z`=南 → Unity `+z`=前=北）。R3F 参照（`regionPositions.ts`）在 Three.js（Y-up 右手）中直接使用 wire `(x,y,z)`，Unity 仅比其多一次 `z` 取反即得同一视觉布局。NPC 尺寸/速度本以米计，随 `S=1` 天然对齐，无额外缩放。

**验收 oracle**：`市场` wire `(24,0,0)` → Unity 世界坐标 **`(24, 0, 0)`**。须加 **Unity Test Framework（EditMode，NUnit）单测**读 `simulation-region-positions.json`（`Assets/StreamingAssets/Fixtures/` 同步副本），逐区域断言变换结果**误差 < 0.5m**。

> `contract-types` 注释改为「Wire 世界坐标（客户端自行映射至引擎坐标系）」。

### 6.3 区域锚点

单一源：`simulation-region-positions.json` → Unity `Assets/StreamingAssets/Fixtures/`（构建或 Editor 脚本同步自 protocol-conformance）。

7 区域：`广场`、`市场`、`餐厅`、`面包店`、`公园`、`住宅区`、`镇政厅`。

### 6.4 居民人设（已定案）

| 数据 | 权威源 |
|------|--------|
| `agent_id`、姓名、职业、`big_five`、regions | **`GET /runs/{id}/manifest`**（创建 run 后拉取） |
| `bio`、展示用关系文案 | 本地 `town-personas.json`（自 `townPersonas.ts` 导出）直至后端 manifest 补字段 |
| 运行时动态字段 | `SimTickSnapshot.agents` |

### 6.5 视觉偏移（非权威）

同区域多 NPC 防堆叠：Unity 侧 `spawnOffset` 表（对齐 Desktop `TOWN_SPAWN_OFFSET`，`z` 符号随 §6.2 wire→Unity 变换），**仅影响渲染**，不参与后端位置回写。

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
| Bootstrap（MonoBehaviour）| 配置、认证、`SimulationSession` 装配 |
| TownScene | 空场景 + **运行时代码生成**地形、Kenney 建筑、区域锚点；`NavMeshSurface` 运行时烘焙 |
| NpcLayer | NPC 预制体 + `NavMeshAgent` + `Animator`；`agent_id` 与后端一致 |
| CameraRig | 鸟瞰 + 跟踪（Phase 2） |
| UiLayer | UI Toolkit（`UIDocument`）面板 |

**UI 选型（定案）**：**UI Toolkit（UXML/USS + `UIDocument`）**——观测面板数据密集（居民列表、事件时间线、指标图表、Tab），UI Toolkit 的 retained-mode + flexbox/USS 与团队 Web/DOM 经验同构、迭代快，为首选。**例外**：Phase 3 世界内气泡/头顶标签走 **uGUI world-space Canvas**（Unity 6 中 UI Toolkit world-space 仍为实验特性）。

**NPC 渲染（定案）**：单骨骼 FBX/glTF（`Xbot`）**共享骨骼动画 + 预制体实例化**，`MaterialPropertyBlock` 标色区分居民（对齐现 Desktop，非每人独立 Mixamo 文件）。

**资产（定案）**：`packages/town-assets/` 为单一源；自 `apps/desktop/public/simulation/assets/` 迁出或 CI 同步脚本导入 Unity `Assets/`，避免双份手工维护。Kenney / Quaternius（CC0）+ 其它免费包可选用。

**性能**：10 NPC ≥ 30 FPS（Windows 中端 GPU）。

**引擎版本**：**Unity 6 LTS（6000.x LTS）+ URP**（以 `ProjectSettings/ProjectVersion.txt` 为准）。

**平台**：Phase 1 **Windows**；**WebGL 传播版为中期战略目标**（本次迁移的决定性理由，连通性 spike 见 §15）；macOS Phase 3。

---

## 8. 认证与配置（已定案）

### 8.1 Phase 0 Spike

- 开发环境：`Authorization: Bearer <access_token>`（手写 token 或 dev 登录复制）
- 启动参数（桌面构建）：`--api <url> --token <token> [--run-id <id>]`
- WebGL 构建无 CLI 参数：改从 URL query（`?api=…&token=…&run=…`）或同源会话读取

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
| 读取 | **AgentTown（桌面构建）** 启动时；Bearer 优先 |
| 401 | 尝试 refresh（若存在 `refresh_token`）；失败则提示打开 Desktop 登录 |

> **WebGL**：无本地文件系统，不读 `session.json`；token 走 URL query / 同源 cookie / 宿主页 `postMessage`（Phase 3 产品化时定稿）。

### 8.3 产品化（Phase 3）

- Unity 内嵌登录页 / 设备码 OAuth（桌面与 WebGL 各自适配）

---

## 9. Run 生命周期与本地历史

| 阶段 | 策略 |
|------|------|
| MVP | 本地 JSON（`Application.persistentDataPath`）/ `PlayerPrefs` 保存最近 12 个 run（对齐 Desktop `runHistory.ts` 语义）；支持 `--run-id` 恢复。WebGL 用 `PlayerPrefs`（IndexedDB 后端） |
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

> Unity 亦可参照现有 UE C++ 实现（双参照）；下表以 R3F 组件为锚列出 Unity 各 Phase 归属。

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
| Conformance | Unity Test Framework（EditMode）消费 `simulation-m1-tick.json` + region fixture |
| Unity | Phase 0：`WireCoordinateTransform` EditMode 单测（市场 oracle）；Phase 1：Play Mode smoke + 打包 smoke（**Windows + WebGL** 双目标） |
| 渲染 | `shoot-simulation-town*.mjs` 退役后由 Unity 截图测试替代 |

---

## 13. 分阶段交付

### Phase 0 — Spike（~1–2 周）

- [ ] **[迁移第一步] Unity WebGL + SSE 连通性 spike**：WebGL 构建（非仅编辑器）打通 create / tick / GET snapshot + SSE live 流；解决浏览器 CORS（服务端 `Access-Control-Allow-Origin`）+ SSE 流式（`DownloadHandlerScript` 分块读 或 `.jslib` `EventSource` 桥接）。详见 §15
- [ ] `apps/town` Unity 6 + Bearer 调通 create / tick / GET ticks/1（桌面构建）
- [ ] 坐标变换（`市场 (24,0,0)` → `(24,0,0)`，误差 < 0.5m）+ 1 NPC 到 `市场`
- [ ] Desktop 并行：`session.json` 写入（最小实现）
- [ ] **Go/No-Go**：**WebGL SSE 连通** + REST + 坐标 + ≥30 FPS；未过则回评估工期，不硬扛

### Phase 1 — 可观看 MVP（~2–3 周）

- [ ] 7 区域 + 10 NPC + Session 完整
- [ ] SSE live + GET 回放 + manifest
- [ ] Run 管理、Tick、居民列表
- [ ] **达 Phase 1 parity → 删除 UE 参照实现 + R3F `town/*`**；Desktop 改启动器

### Phase 2 — 体验对齐（~2 周）

- [ ] 决策/事件/跟踪/热力/日夜/metrics
- [ ] Token 文件联调

### Phase 3 — 产品化

- [ ] 上帝模式 + 交互 3D 叠加（M3）
- [ ] Unity CI、Windows 安装包、**WebGL 传播版发布**
- [ ] macOS 构建
- [ ] `sim.*` conformance 扩展

---

## 14. 验收标准（Phase 1）

1. 独立启动 AgentTown（token 文件或 CLI）
2. 创建 run → `GET /manifest` → 10 居民 roster 正确
3. 手动 5 tick；位置与 region fixture 一致（§6.2 变换后误差 < 0.5m）
4. 20 tick 回放 seek / 倍速，无 SSE 污染
5. 10 NPC ≥ 30 FPS（Windows）
6. **（迁移护栏）** WebGL 构建能收到 SSE live tick（Phase 0 连通性 spike 结论在 Phase 1 保持绿）

---

## 15. 从 UE 迁移

> **背景**：2026-07-08 由 Unreal Engine 5.8 改回 **Unity 6 LTS + URP + C#**。**决定性理由**：中期已确认要做 **Web 传播版**，而 UE **无原生 Web 导出**、**Unity 原生 WebGL2**。**低风险依据**：`apps/town` 现有实现**无任何 `.uasset`**（7 区域场景全部运行时代码生成），且客户端逻辑已有**两份参照实现**（Desktop R3F TypeScript + 现有 UE C++），Unity C# 属「照蓝图翻译」。

### 15.1 可复用清单（零改动 / 直接照译）

| 类别 | 复用物 | 复用方式 |
|------|--------|----------|
| 后端 | `simulation/` 包、REST/SSE 契约、Postgres 四表 | **完全不动** |
| Fixtures | `simulation-region-positions.json`、`simulation-m1-tick.json` | 直接复用（同步至 `Assets/StreamingAssets/Fixtures/`） |
| 类型契约 | `packages/contract-types` / OpenAPI | 手写 C# DTO 对齐（同 UE 手写路径） |
| **双参照实现** | Desktop R3F（TS）+ 现有 UE C++ | 逐段照译到 C#：R3F 给「wire 直用映射 + 建镇布局」蓝图，UE 给「坐标/Session 状态机/SSE 事件处理」蓝图 |
| 资产 | `packages/town-assets`（Kenney/Quaternius CC0 FBX/glTF） | Unity 直接导入 `Assets/` |
| 人设 | `town-personas.json`（自 `townPersonas.ts` 导出） | 直接复用 |

### 15.2 移植顺序

1. **[迁移第一步 · 命门] Unity WebGL + SSE 连通性 spike**——早验风险，先于一切功能移植。在 **WebGL 构建**（非仅 Editor：Editor 走 .NET 网络栈、WebGL 走浏览器，二者不等价）中打通 create / tick / GET snapshot + **SSE live 流**。需解决：
   - **浏览器 CORS**：服务端对 Web 源发 `Access-Control-Allow-Origin`（`simulation/*` 与 inference 代理路由）。
   - **SSE 流式**：`UnityWebRequest` 默认 handler 不做增量流；用 `DownloadHandlerScript` 分块读，或 `.jslib` 包 `EventSource`/`fetch`+`ReadableStream` 桥接回 C#。
   - **Go/No-Go**：WebGL 构建能收到实时 tick 事件。**UE 无此路径，故 Unity 必须最早证明能做到**——不过则迁移价值存疑，回评估。
2. **坐标变换** `WireCoordinateTransform`（C#）+ EditMode 单测（市场 `(24,0,0)`→`(24,0,0)`，误差 < 0.5m）——照译 UE，改 Z-up→Y-up（§6.2）。
3. **SimulationSession 单状态机**（C#）+ REST/SSE 客户端——照译 UE C++（字段/模式规则/事件表见 §4、§6.6）。
4. **运行时建镇**（7 区域代码生成）+ `NavMeshSurface` 运行时烘焙——照译 R3F `regionLayout.ts` + UE spawner。
5. **NPC**：`NavMeshAgent` + `Animator` + 预制体实例化标色。
6. **UI Toolkit 观测面板**：Tick 控制、居民列表、事件流（Phase 1 范围，见 §11）。
7. **Phase 1 parity** → 达 §14 验收全过。

### 15.3 UE 退役时机

Unity 达 **Phase 1 parity（§14 验收全过）** 后，删除 `apps/town` 下 UE 工程（`Source/`、`*.uproject`、UE 专属 `Config/`），比照 **R3F 冻结→删除先例**。退役前 UE 代码冻结为参照、不再新增功能；新需求只进 Unity。R3F `simulation/town/*` 同步在 Unity Phase 1 后删除（§3）。历史与理由以本节 + git 为准，不设归档目录。

### 15.4 迁移中保持不变的引擎无关契约

以下由 §4–§6、§14 定义，**迁移只换渲染 / UI / 坐标实现，契约本身不动**：`SimulationSession` 单状态机字段与模式规则、Live/Replay 语义、SSE 事件处理表（含忽略 `tick_frame`）、REST API 映射、坐标契约语义（wire 侧不变，仅换引擎侧公式）、fixtures、分阶段交付节奏、验收标准。**若移植中发现须改上述任一契约或与后端不一致 → 立即停下回报，不自行改契约。**

---

## 16. 已定案决策摘要

| # | 决策 |
|---|------|
| 1 | 认证：Spike 用 Bearer；并行 Desktop 写 `session.json`（WebGL 走 URL/同源） |
| 2 | 坐标：wire → Unity `(x, y, -z)` 单点变换（Y-up 左手系，`S=1` 米）；市场 `(24,0,0)`→`(24,0,0)` |
| 3 | Roster：`GET /manifest` 权威；bio 本地 JSON 兜底 |
| 4 | Run 历史：本地缓存 + 中期 `GET /runs` |
| 5 | 主入口 AgentTown；Desktop 启动器副入口 |
| 6 | R3F **与 UE 均冻结对照**；Unity 达 Phase 1 parity 后删除二者 3D 代码 |
| 7 | 资产 `packages/town-assets`（CC0 Kenney/Quaternius + 免费包） |
| 8 | **Unity 6 LTS + URP**；Windows 先行、**WebGL 中期**、macOS 后 |
| 9 | Replay 仅 GET 逐帧；Live 忽略 `tick_frame` |
| 10 | MVP FE 任务映射为 **UT-***（Unity Town；见 MVP 计划 §2.1，编号与 `UE-*` 1:1） |
| 11 | UI 选型 UI Toolkit（世界内气泡例外走 uGUI world-space）；JSON 用 Newtonsoft |
| 12 | **2026-07-08**：由 **UE 5.8 改回 Unity 6 LTS**；决定性理由 = 中期做 Web 传播版、UE 无原生 Web 导出而 Unity 原生 WebGL2；`apps/town` 无 `.uasset`（全运行时生成）迁移风险低；UE Phase 1 代码降为将退役参照实现（§15） |

---

## 相关文档

- [AI 小镇 MVP 开发计划](AI小镇MVP开发计划.md)（§2.1 UT 任务映射）
- [多 AI 模拟愿景](multi-ai-simulation-vision.md)
- 后端 → `apps/server/agentcore/api/routes/simulation/runs.py`
