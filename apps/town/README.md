# AgentTown (Unreal Engine 5.8)

Unreal Engine observation client for AgentCore simulation. **Phase 1** — SSE live stream, GET replay with playhead, manifest roster, up to 12 NPCs.

Spec: [`docs/06-规划/AgentTown客户端规格.md`](../../docs/06-规划/AgentTown客户端规格.md)

## Prerequisites

- [Unreal Engine 5.8](https://www.unrealengine.com/download) (`.uproject` pins `EngineAssociation: 5.8`)
- Visual Studio 2022 with **Desktop development with C++** and **Game development with C++**
- AgentCore backend with `SIMULATION_ENABLED=true` on `http://localhost:8000`

## Install UE 5.8 (automation)

From repo root:

```powershell
pnpm town:install-ue
```

The script is **idempotent** and logs to `apps/town/logs/`:

1. Detects existing installs under `C:\Program Files\Epic Games\UE_*`
2. If missing, installs **Epic Games Launcher** via winget (`EpicGames.EpicGamesLauncher`) when needed
3. Documents (but does **not** auto-download multi-GB UE) unless you opt in:

```powershell
$env:AGENTTOWN_INSTALL_UE = '1'
pnpm town:install-ue
```

That triggers the launcher CLI:

```powershell
EpicGamesLauncher.exe -silent -install -appUnrealEngine=UE_5.8
```

**Offline MSI** (download from Epic Developer portal first):

```powershell
msiexec /i "C:\Path\To\UnrealEngine-5.8.msi" /qn
```

## Build, test, screenshot (CI / local)

| Command | Script | Notes |
|---------|--------|-------|
| `pnpm town:build` | `scripts/build-agenttown.ps1` | Generate VS files + compile `AgentTownEditor` Win64 Development + automation tests |
| `pnpm town:test` | `scripts/test-agenttown.ps1` | `AgentTown.Simulation` via `UnrealEditor-Cmd` only |
| `pnpm town:shoot` | `scripts/shoot-agenttown.ps1` | `HighResShot 1920x1080` → `shoot-out/agenttown-pie.png`; **skips** if UE not installed |

Logs: `apps/town/logs/`. Build/test require UE 5.8 at `C:\Program Files\Epic Games\UE_5.8`.

## Quick start (against localhost:8000)

1. Start the AgentCore backend with simulation enabled and a valid auth token.
2. Open `AgentTown.uproject` in UE 5.8 (generate VS project files on first open).
3. Press **Play** in the editor.
4. In the top-left Slate HUD:
   - Click **Create Run** → `POST /v1/simulation/runs` → `GET /manifest` → connect SSE
   - Click **Advance Tick** → `POST .../tick` → on `sim.tick_ended` fetch `GET .../ticks/{n}` (not POST body snapshot)
   - Use **Replay** controls (◀ ▶ ▶▶ / Live) and speed (0.5×–4×) to scrub history
5. Resident names come from **manifest** (right panel). NPC capsules use distinct colors (up to 12 agents).

### CLI / session.json

Launch parameters (Desktop「打开小镇」or command line):

```powershell
AgentTown.exe --api=http://localhost:8000 --token=<access_token> [--run-id=<run_id>]
```

Fallback when `--api` / `--token` omitted: `%APPDATA%\AgentCore\session.json`

```json
{
  "api_base": "http://localhost:8000",
  "access_token": "<jwt or session token>"
}
```

## Live vs Replay (Phase 1)

| Mode | SSE | Position updates |
|------|-----|------------------|
| **Live** (`playhead == null`) | Handles `sim.tick_started/ended`, `sim.agent_action`, `sim.agent_state`; **ignores `sim.tick_frame`** | On `sim.tick_ended` → `GET /ticks/{n}` → `ApplySnapshot` only |
| **Replay** (`playhead` set) | **Ignored** (no world-state SSE) | `GET /ticks/{playhead}` only; NPC snap |
| **Playing** | Same as Replay | Timer advances `playhead++` via `SeekTick` |
| **At tail** (`playhead >= tick`) | `GoLive()` resumes SSE consumption | Fetches latest `GET /ticks/{tick}` |

**Single state machine**: `FSimulationSession` owns mode, playhead, SSE, REST, and tick cache. Coordinate transform stays in `FWireCoordinateTransform` only.

## Open in Unreal Editor

1. Install Epic Games Launcher → UE 5.8.
2. Double-click `apps/town/AgentTown.uproject`.
3. Allow **Generate Visual Studio project files** on first open.
4. Wait for C++ compile to finish, then **Play**.

## Run Automation tests (coordinate contract)

**Session Frontend**

1. **Window → Developer Tools → Session Frontend**
2. **Automation** tab → filter `AgentTown.Simulation`
3. **Start Tests**

**Command line**

```powershell
UnrealEditor-Cmd.exe "C:\Project\AgentCore\apps\town\AgentTown.uproject" `
  -ExecCmds="Automation RunTests AgentTown.Simulation; Quit" -unattended -nopause -log
```

(Adjust `UnrealEditor-Cmd.exe` path to your UE 5.8 install.)

### Expected passing tests

| Test | Assertion |
|------|-----------|
| `WireCoordinate.MarketMapsTo2400_0_0` | Wire `(24,0,0)` → UE `(2400,0,0)` (×100 world scale) |
| `WireCoordinate.AllRegionsFromFixture` | All 7 region anchors from `Content/Fixtures/simulation-region-positions.json` |
| `Session.ApplySnapshotTransformsAgents` | Session applies wire→UE and exposes agent UE positions |

## Project layout

```
apps/town/
├── AgentTown.uproject
├── Source/AgentTown/
│   ├── Public/
│   │   ├── Simulation/       # Session, REST, SSE, wire→UE transform
│   │   ├── Town/             # GameMode, HUD, NPC manager, bootstrap, building spawner
│   │   └── Config/           # CLI + session.json loader
│   ├── Private/
│   └── Private/Tests/        # Automation (coordinate contract)
├── Content/Fixtures/         # simulation-region-positions.json
└── Config/                   # DefaultGame.ini → ATownGameMode
```

## 3D assets (UE-02)

**Phase 1 (UE-02, current):** Seven gameplay zones are built at runtime from engine basic shapes — no Editor import or `.uasset` binaries required. `ATownBuildingSpawner` mirrors Desktop `regionLayout.ts` + `townGround.ts`:

- Region anchors from `Content/Fixtures/simulation-region-positions.json`
- Per-zone colored cubes/cylinders (广场/市场/餐厅/面包店/公园/住宅区/镇政厅)
- Asphalt road grid + zone ground lots
- `ATownObserverPawn` frames all regions (Desktop `TOWN_VIEW_CENTER` / `TOWN_CAMERA_POS`)

Press **Play** in UE 5.8 to see the placeholder town immediately.

**Future (Kenney GLB):** Kenney / Xbot live in `apps/desktop/public/simulation/assets/` until `packages/town-assets` migration.

```powershell
powershell -ExecutionPolicy Bypass -File apps/town/scripts/sync-assets.ps1
```

Copies GLBs to `Content/Town/SourceAssets/` (gitignored). In UE: **Import** into `Content/Town/Meshes`, then swap placeholders in `ATownBuildingSpawner`.

## Architecture (Phase 1)

| Component | Role |
|-----------|------|
| `FSimulationSession` | Single client state machine; Live/Replay share `ApplySnapshot` |
| `FSimulationRestClient` | `POST /runs`, `POST /tick`, `GET /ticks/{n}`, `GET /manifest` |
| `FSimulationSseClient` | `GET /runs/{id}/stream` — live events (ignores `tick_frame` in Live) |
| `FWireCoordinateTransform` | **Only** wire→UE transform: `ue = (wire.x, -wire.z, wire.y) × 100` (`WorldScale`) |
| `ATownBootstrap` | Spawns ground, `ATownBuildingSpawner`, region markers |
| `ATownBuildingSpawner` | UE-02 runtime town: roads, zone lots, colored placeholder buildings |
| `ATownGameMode` | Config, bootstrap, resume `--run-id` |
| `ATownObserverPawn` | Overview camera framing all seven regions |
| `ATownNpcManager` | Spawn/update up to 12 colored `ACharacter` capsules per `agent_id` |
| `STownHUDOverlay` | Run / tick / replay / speed / manifest resident list |

## Coordinate transform (§6.2)

Wire (Y-up, right-handed) → Unreal (Z-up, left-handed):

```
ue.X = wire.x  * 100   # WorldScale: 1 wire unit = 1 m = 100 UE cm
ue.Y = -wire.z * 100
ue.Z = wire.y  * 100   # NPC capsule / speed stay human-scale (not ×100)
```

Implemented in `FWireCoordinateTransform::ToUnreal` — **only** call site for snapshot positions.

## Related

- MVP tasks: `UE-*` in [`AI小镇MVP开发计划.md`](../../docs/06-规划/AI小镇MVP开发计划.md) §2.1
- Region fixture source of truth: `packages/protocol-conformance/fixtures/simulation-region-positions.json`
- Desktop API reference: `apps/desktop/src/renderer/services/simulation/api.ts`
