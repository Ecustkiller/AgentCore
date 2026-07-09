#if UNITY_EDITOR
using System.IO;
using AgentTown.Town;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

namespace AgentTown.Editor
{
    /// <summary>
    /// One-shot project wiring: URP pipeline, PanelSettings, Town.unity + Bootstrap refs, build scene list.
    /// Menu: AgentTown → Setup Project. Batch: -executeMethod AgentTown.Editor.AgentTownProjectSetup.SetupFromBatch
    /// </summary>
    public static class AgentTownProjectSetup
    {
        private const string SettingsDir = "Assets/Settings";
        private const string UiDir = "Assets/UI";
        private const string ScenesDir = "Assets/Scenes";
        private const string PipelinePath = SettingsDir + "/URP-Asset.asset";
        private const string RendererPath = SettingsDir + "/URP-Renderer.asset";
        private const string PanelSettingsPath = UiDir + "/TownHudPanelSettings.asset";
        private const string TownScenePath = ScenesDir + "/Town.unity";

        [MenuItem("AgentTown/Setup Project")]
        public static void SetupFromMenu() => Setup();

        public static void SetupFromBatch() => Setup();

        private static void Setup()
        {
            EnsureFolder(SettingsDir);
            EnsureFolder(ScenesDir);

            UniversalRenderPipelineAsset pipeline = EnsureUrpPipeline();
            AssignRenderPipeline(pipeline);
            PlayerSettings.colorSpace = ColorSpace.Linear;

            PanelSettings panelSettings = EnsurePanelSettings();
            VisualTreeAsset uxml = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(UiDir + "/TownHud.uxml");
            StyleSheet uss = AssetDatabase.LoadAssetAtPath<StyleSheet>(UiDir + "/TownHud.uss");

            if (uxml == null)
            {
                throw new FileNotFoundException("Missing Assets/UI/TownHud.uxml");
            }

            CreateOrUpdateTownScene(uxml, panelSettings, uss);
            SetBuildScenes();

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[AgentTown] Project setup complete — open Assets/Scenes/Town.unity and press Play.");
        }

        private static void EnsureFolder(string assetPath)
        {
            if (AssetDatabase.IsValidFolder(assetPath))
            {
                return;
            }

            string parent = Path.GetDirectoryName(assetPath)?.Replace('\\', '/') ?? "Assets";
            string leaf = Path.GetFileName(assetPath);
            if (!AssetDatabase.IsValidFolder(parent))
            {
                EnsureFolder(parent);
            }

            AssetDatabase.CreateFolder(parent, leaf);
        }

        private static UniversalRenderPipelineAsset EnsureUrpPipeline()
        {
            var existing = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
            if (existing != null)
            {
                return existing;
            }

            var rendererData = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(rendererData, RendererPath);

            var pipelineAsset = ScriptableObject.CreateInstance<UniversalRenderPipelineAsset>();
            AssetDatabase.CreateAsset(pipelineAsset, PipelinePath);

            SerializedObject pipelineSo = new SerializedObject(pipelineAsset);
            SerializedProperty rendererList = pipelineSo.FindProperty("m_RendererDataList");
            rendererList.arraySize = 1;
            rendererList.GetArrayElementAtIndex(0).objectReferenceValue = rendererData;
            pipelineSo.ApplyModifiedPropertiesWithoutUndo();

            return pipelineAsset;
        }

        private static void AssignRenderPipeline(UniversalRenderPipelineAsset pipeline)
        {
            GraphicsSettings.defaultRenderPipeline = pipeline;

            string[] qualityNames = QualitySettings.names;
            for (int i = 0; i < qualityNames.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, applyExpensiveChanges: false);
                QualitySettings.renderPipeline = pipeline;
            }
        }

        private static PanelSettings EnsurePanelSettings()
        {
            var existing = AssetDatabase.LoadAssetAtPath<PanelSettings>(PanelSettingsPath);
            if (existing != null)
            {
                return existing;
            }

            var panelSettings = ScriptableObject.CreateInstance<PanelSettings>();
            panelSettings.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            panelSettings.referenceResolution = new Vector2Int(1920, 1080);
            AssetDatabase.CreateAsset(panelSettings, PanelSettingsPath);
            return panelSettings;
        }

        private static void CreateOrUpdateTownScene(
            VisualTreeAsset uxml,
            PanelSettings panelSettings,
            StyleSheet uss)
        {
            Scene scene;
            if (File.Exists(TownScenePath))
            {
                scene = EditorSceneManager.OpenScene(TownScenePath, OpenSceneMode.Single);
            }
            else
            {
                scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            }

            TownBootstrap bootstrap = Object.FindFirstObjectByType<TownBootstrap>();
            if (bootstrap == null)
            {
                var go = new GameObject("TownBootstrap");
                bootstrap = go.AddComponent<TownBootstrap>();
            }

            bootstrap.ConfigureHudAssets(uxml, panelSettings, uss);
            EditorUtility.SetDirty(bootstrap);

            EditorSceneManager.MarkSceneDirty(scene);
            if (!EditorSceneManager.SaveScene(scene, TownScenePath))
            {
                throw new IOException($"Failed to save scene at {TownScenePath}");
            }
        }

        private static void SetBuildScenes()
        {
            var scene = AssetDatabase.LoadAssetAtPath<SceneAsset>(TownScenePath);
            if (scene == null)
            {
                return;
            }

            EditorBuildSettings.scenes = new[]
            {
                new EditorBuildSettingsScene(TownScenePath, true),
            };
        }
    }
}
#endif
