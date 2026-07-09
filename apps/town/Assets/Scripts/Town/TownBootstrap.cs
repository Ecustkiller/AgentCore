using System;
using System.Threading.Tasks;
using AgentTown.Simulation;
using AgentTown.UI;
using UnityEngine;
using UnityEngine.UIElements;

namespace AgentTown.Town
{
    /// <summary>
    /// Top-level scene assembler (§7 Bootstrap, §15.2). The single MonoBehaviour that needs to be
    /// placed in the Town scene — everything else is spawned in code. It resolves the launch
    /// config (§8), configures the <see cref="SimulationSession"/> singleton, builds the town +
    /// NavMesh, spawns/seeds NPCs, frames the bird's-eye camera, wires the UI to the session, and
    /// pumps <see cref="SimulationSession.Update"/> every frame. On a <c>--run-id</c> it resumes the
    /// run (manifest + SSE + first frame), mirroring the retired UE <c>TownGameMode</c>.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownBootstrap : MonoBehaviour
    {
        [Header("UI (assign in Editor — see EDITOR-WIRING.md)")]
        [Tooltip("TownHud.uxml — the observer panel layout.")]
        [SerializeField] private VisualTreeAsset hudUxml;

        [Tooltip("A PanelSettings asset for the runtime UI Toolkit panel.")]
        [SerializeField] private PanelSettings hudPanelSettings;

        [Tooltip("Optional: TownHud.uss, applied if the UXML does not link it.")]
        [SerializeField] private StyleSheet hudStyleSheet;

        private SimulationSession session;

        private async void Start()
        {
            try
            {
                await BootAsync();
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
        }

        private void Update()
        {
            session?.Update(Time.deltaTime);
        }

        private void OnDestroy()
        {
            // Stop the live stream when the town is torn down.
            session?.Reset();
        }

#if UNITY_EDITOR
        private void OnDrawGizmos()
        {
            // Edit-mode footprint so Scene 视图不是「完全空白」— 真实几何仍在 Play 时生成。
            Gizmos.color = new Color(0.25f, 0.72f, 0.35f, 0.35f);
            Vector3 ground = new Vector3(TownVisualLayout.GroundSize.x, 0.05f, TownVisualLayout.GroundSize.y);
            Gizmos.DrawCube(Vector3.zero, ground);

            Gizmos.color = new Color(1f, 0.85f, 0.2f, 0.9f);
            Vector3 center = WireCoordinateTransform.ToUnity(
                TownVisualLayout.ViewCenterWire.x,
                TownVisualLayout.ViewCenterWire.y,
                TownVisualLayout.ViewCenterWire.z);
            Gizmos.DrawWireSphere(center, 2f);
        }
#endif

        private async Task BootAsync()
        {
            AgentTownLaunchConfig config = AgentTownLaunchConfig.Load();

            session = SimulationSession.Instance;
            session.Configure(config.ApiBase, config.AccessToken, config.RunId);

            await TownPersonas.LoadAsync();

            Material npcMaterial = CreatePlaceholderMaterial("TownNpc");
            TownBuilder builder = SpawnBuilder();
            await builder.BuildAsync();

            TownNpcManager npcManager = SpawnNpcManager(npcMaterial);
            npcManager.SeedFromPersonas(builder.RegionAnchors);

            EnsureLighting();
            FrameCamera();
            WireHud();

            if (!string.IsNullOrEmpty(config.RunId))
            {
                ResumeLaunchRun();
            }
        }

        private TownBuilder SpawnBuilder()
        {
            var go = new GameObject("TownBuilder");
            go.transform.SetParent(transform, false);
            return go.AddComponent<TownBuilder>();
        }

        private TownNpcManager SpawnNpcManager(Material npcMaterial)
        {
            var go = new GameObject("TownNpcManager");
            go.transform.SetParent(transform, false);
            var manager = go.AddComponent<TownNpcManager>();
            manager.Bind(session, npcMaterial);
            return manager;
        }

        private void EnsureLighting()
        {
            foreach (Light existing in FindObjectsByType<Light>(FindObjectsSortMode.None))
            {
                if (existing.type == LightType.Directional)
                {
                    return;
                }
            }

            var lightGo = new GameObject("TownSun");
            lightGo.transform.SetParent(transform, false);
            lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            Light sun = lightGo.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.96f, 0.9f);
            sun.intensity = 1.1f;
            sun.shadows = LightShadows.Soft;
        }

        private void FrameCamera()
        {
            Camera cam = Camera.main;
            if (cam == null)
            {
                var camGo = new GameObject("TownCamera") { tag = "MainCamera" };
                cam = camGo.AddComponent<Camera>();
                camGo.AddComponent<AudioListener>();
            }

            TownCamera townCamera = cam.GetComponent<TownCamera>();
            if (townCamera == null)
            {
                townCamera = cam.gameObject.AddComponent<TownCamera>();
            }

            townCamera.Frame();
        }

        private void WireHud()
        {
            if (hudUxml != null && hudPanelSettings != null)
            {
                // Build inactive so UIDocument.OnEnable sees the assets before constructing the tree.
                var uiGo = new GameObject("TownHud");
                uiGo.transform.SetParent(transform, false);
                uiGo.SetActive(false);

                var document = uiGo.AddComponent<UIDocument>();
                document.panelSettings = hudPanelSettings;
                document.visualTreeAsset = hudUxml;

                TownHudController controller = uiGo.AddComponent<TownHudController>();
                uiGo.SetActive(true);
                controller.Bind(session);
                return;
            }

            TownHudController existing = FindFirstObjectByType<TownHudController>();
            if (existing != null)
            {
                existing.Bind(session);
                return;
            }

            Debug.LogWarning(
                "[AgentTown] HUD not wired — assign hudUxml + hudPanelSettings on TownBootstrap, " +
                "or add a UIDocument + TownHudController to the scene (see EDITOR-WIRING.md).");
        }

        private void ResumeLaunchRun()
        {
            // RunId is already set via Configure; fetch manifest + connect SSE, then a first frame.
            session.BootstrapActiveRun();
            _ = session.FetchLiveTickAsync(1);
        }

        private static Material CreatePlaceholderMaterial(string name)
        {
            Shader shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            return new Material(shader) { name = name };
        }

#if UNITY_EDITOR
        /// <summary>Editor setup assigns HUD assets so they persist in the scene YAML.</summary>
        internal void ConfigureHudAssets(
            VisualTreeAsset uxml, PanelSettings panelSettings, StyleSheet styleSheet)
        {
            hudUxml = uxml;
            hudPanelSettings = panelSettings;
            hudStyleSheet = styleSheet;
        }
#endif
    }
}
