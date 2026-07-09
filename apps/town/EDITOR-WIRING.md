# AgentTown — Editor 接线清单（Phase 1 上层落地后）

> 上层（运行时建镇 + NPC + UI Toolkit 面板 + Bootstrap）已全部以**运行时代码生成 + 文本资产**落地，无需 Editor 即可编写。
> 以下步骤需在 **Unity 6000.0.78f1** 打开工程后完成——它们依赖 Editor 生成的二进制/GUID（`.meta`、`.unity`、`PanelSettings.asset`、URP 管线资产、真实美术资产）。

## 0. 打开工程（生成 .meta）
- 用 Unity 6000.0.78f1 打开 `apps/town`。首次导入会为所有新 `.cs`/`.uxml`/`.uss`/`.json` 生成 `.meta`（GUID）。提交这些 `.meta`。
- 确认 Package Manager 已解析 `com.unity.ai.navigation`、`com.unity.render-pipelines.universal`、`com.unity.nuget.newtonsoft-json`（见 `Packages/manifest.json`）。

## 1. URP 管线（必做，否则画面漆黑/粉红）
- `Assets/Create/Rendering/URP Asset (with Universal Renderer)` → 得到 URP Asset + Renderer。
- `Project Settings/Graphics` → Scriptable Render Pipeline Settings 指向该 URP Asset；`Project Settings/Quality` 各档同样指向。
- 占位材质由代码创建（`Shader.Find("Universal Render Pipeline/Lit")`）——URP 就绪后 `_BaseColor` 着色即生效。

## 2. Town 场景 + Bootstrap（必做）
- 新建空场景 `Assets/Scenes/Town.unity`。
- 建空物体 `TownBootstrap`，挂 `AgentTown.Town.TownBootstrap`。
- 场景可只保留默认 `Main Camera` 与 `Directional Light`（Bootstrap 会复用相机、并在缺灯时自建）。其余运行时生成。
- `File/Build Settings` → 把 `Town.unity` 设为首个场景。

## 3. UI Toolkit 面板绑定（必做）
- `Assets/Create/UI Toolkit/Panel Settings Asset` → `Assets/UI/TownHudPanelSettings.asset`；其 Theme 指定一个 Theme Style Sheet（`Assets/Create/UI Toolkit/TSS`，或默认运行时主题）。
- 在 `TownBootstrap` Inspector：
  - `Hud Uxml` ← `Assets/UI/TownHud.uxml`
  - `Hud Panel Settings` ← 上面的 `TownHudPanelSettings.asset`
  - `Hud Style Sheet` ← `Assets/UI/TownHud.uss`（可选；UXML 已 `<Style src>` 链接，双保险）
- 运行时 Bootstrap 会自建 `UIDocument`+`TownHudController` 并绑定。若改为「场景内手放 UIDocument」，则在该物体挂 `TownHudController`，把 UXML/PanelSettings 填到 UIDocument 上即可，Bootstrap 会自动发现并 `Bind`。

## 4. 真实美术资产（替换占位，Phase 1 收尾/Phase 2）
- **建筑**：导入 Kenney/Quaternius 建筑 FBX/glTF 到 `Assets/`；把 `TownBuilder.SpawnPlaceholder` 的 primitive 换成对应 prefab（布局锚点/旋转/缩放已在 `TownVisualLayout` 就位，1:1 对应 Desktop `regionLayout.ts`）。
- **NPC**：导入单骨骼 `Xbot` skinned mesh + `AnimatorController`；在 `TownNpc.Initialize` 用 skinned mesh 替换占位胶囊，给已挂上的 `Animator` 赋 controller（当前控制器留空为占位）。`MaterialPropertyBlock` 标色逻辑无需改。
- 资产单一源 `packages/town-assets/`（§7）；用 CI 同步脚本导入，勿双份手工维护。

## 5. NavMesh（无需手动烘焙）
- `TownBuilder` 运行时对地面 `NavMeshSurface.BuildNavMesh()`（agent type 默认 Humanoid）。无需场景内烘焙或 `NavMeshBoundsVolume`。
- 若换真实带碰撞的建筑并希望绕行，改 `NavMeshSurface.useGeometry`/`collectObjects` 或加 `NavMeshModifier`。

## 6. 启动参数 / 会话
- 桌面：`AgentTown.exe --api <url> --token <token> [--run-id <id>]`（`AgentTownLaunchConfig` 解析）；亦读 `%APPDATA%/AgentCore/session.json`（§8.2）。
- WebGL：URL query `?api=&token=&run=`；StreamingAssets 走 `UnityWebRequest`（已实现）。需后端对 Web 源开 CORS + SSE 流式（Phase 0 spike，§15.2）。

## 7. 测试
- `Window/General/Test Runner` → EditMode 跑：`WireCoordinateTransformTests`、`SimulationSessionTests`、`TownVisualLayoutTests`、`TownPersonaTests`、`AgentTownLaunchConfigTests`。
- Phase 1 Play Mode / 打包 smoke（Windows + WebGL）按 §12 补。

## 8. 构建目标
- `Build Settings` 添加 Windows 与 WebGL 目标；WebGL 需 Newtonsoft/UnityWebRequest（已在依赖内）。
