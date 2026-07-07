# AgentTown (Unreal Engine 5.5)

Unreal Engine observation client for AgentCore simulation. **Phase 0 (UE-00)** — C++ skeleton, coordinate transform, Automation tests. No playable map yet.

Spec: [`docs/06-规划/AgentTown客户端规格.md`](../../docs/06-规划/AgentTown客户端规格.md)

## Prerequisites

- [Unreal Engine 5.5](https://www.unrealengine.com/download) (`.uproject` pins `EngineAssociation: 5.5`; 5.4 may work with retarget)
- Visual Studio 2022 with **Desktop development with C++** and **Game development with C++**
- AgentCore backend with `SIMULATION_ENABLED=true` (for REST spike in UE-00)

## Open in Unreal Editor

1. Install Epic Games Launcher → UE 5.5.
2. Double-click `apps/town/AgentTown.uproject` (or Add from Epic Launcher).
3. Allow **Generate Visual Studio project files** on first open.
4. Wait for shader compile and C++ compile to finish.

## Run Automation tests (coordinate contract)

**Session Frontend**

1. **Window → Developer Tools → Session Frontend**
2. **Automation** tab → filter `AgentTown.Simulation`
3. **Start Tests**

**Command line (after building Editor target)**

```powershell
& "C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun `
  -project="C:\Project\AgentCore\apps\town\AgentTown.uproject" `
  -noP4 -platform=Win64 -clientconfig=Development -build -compile
```

Then run automation from Editor or:

```powershell
UnrealEditor-Cmd.exe "C:\Project\AgentCore\apps\town\AgentTown.uproject" `
  -ExecCmds="Automation RunTests AgentTown.Simulation; Quit" -unattended -nopause -log
```

(Adjust `UnrealEditor-Cmd.exe` path to your UE 5.5 install.)

### Expected passing tests

| Test | Assertion |
|------|-----------|
| `WireCoordinate.MarketMapsTo24_0_0` | Wire `(24,0,0)` → UE `(24,0,0)` |
| `WireCoordinate.AllRegionsFromFixture` | All 7 region anchors from `Content/Fixtures/simulation-region-positions.json` |
| `Session.ApplySnapshotTransformsAgents` | Session applies wire→UE without error |

## Project layout

```
apps/town/
├── AgentTown.uproject
├── Source/AgentTown/
│   ├── Public/Simulation/     # WireCoordinateTransform, SimulationSession
│   ├── Private/Simulation/
│   └── Private/Tests/         # Automation (UE-00)
├── Content/Fixtures/          # simulation-region-positions.json (sync from protocol-conformance)
└── Config/
```

## Coordinate transform (§6.2)

Wire (Y-up, right-handed) → Unreal (Z-up, left-handed):

```
ue.X = wire.x
ue.Y = -wire.z
ue.Z = wire.y
```

Implemented in `FWireCoordinateTransform::ToUnreal` — **only** call site for snapshot positions.

## 3D assets

Kenney / Xbot assets live in `apps/desktop/public/simulation/assets/` until migrated — see `packages/town-assets/README.md`.

Import into `Content/Town/` for UE-02 (7-region scene).

## UE-00 Spike checklist

- [ ] Bearer REST: `POST /runs`, `POST /tick`, `GET /ticks/1`
- [ ] 1 NPC NavMesh to `市场` wire position
- [ ] Automation tests green
- [ ] ≥ 30 FPS smoke (Windows mid-tier GPU)
- [ ] Desktop `session.json` writer (DT-01, parallel)

## Related

- MVP tasks: `UE-*` in [`AI小镇MVP开发计划.md`](../../docs/06-规划/AI小镇MVP开发计划.md) §2.1
- Region fixture source of truth: `packages/protocol-conformance/fixtures/simulation-region-positions.json`
