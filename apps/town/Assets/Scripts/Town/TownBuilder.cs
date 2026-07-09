using System.Collections.Generic;
using System.Threading.Tasks;
using AgentTown.Simulation;
using Unity.AI.Navigation;
using UnityEngine;
using UnityEngine.AI;

namespace AgentTown.Town
{
    /// <summary>
    /// Runtime town builder (§7 TownScene, §15.2 step 4). Generates the whole world in code —
    /// grass base, per-region zone lots, road grid, placeholder buildings, and region anchor
    /// markers — then bakes a <see cref="NavMeshSurface"/> so NPCs can path (§7). No scene assets
    /// or <c>.uasset</c>: primitives stand in until the real Kenney meshes are imported in Editor.
    ///
    /// <para>All geometry is placed via <see cref="WireCoordinateTransform"/>, so it lines up with
    /// agent positions coming from the backend. Region anchors are read from the synced fixture
    /// (§6.3) through <see cref="StreamingAssetsText"/> so it also works under WebGL.</para>
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownBuilder : MonoBehaviour
    {
        private const string RegionFixture = "Fixtures/" + RegionPositions.FixtureFileName;

        // Thin coloured slabs; larger Y = drawn on top (grass < zones < roads).
        private const float ZoneY = 0.03f;
        private const float RoadY = 0.07f;
        private const float SlabThickness = 0.08f;
        private const float MarkerHeight = 1.6f;

        private Material sharedMaterial;
        private bool built;

        /// <summary>Region name → Unity anchor (transformed). Populated after <see cref="BuildAsync"/>.</summary>
        public IReadOnlyDictionary<string, Vector3> RegionAnchors => regionAnchors;

        private readonly Dictionary<string, Vector3> regionAnchors = new();

        /// <summary>Build the full town once (idempotent). Awaitable so the anchor fixture can stream on WebGL.</summary>
        public async Task BuildAsync()
        {
            if (built)
            {
                return;
            }

            built = true;
            EnsureMaterial();

            NavMeshSurface surface = BuildGroundAndNav();
            BuildGroundPatches(TownVisualLayout.Zones, "Zones", ZoneY);
            BuildGroundPatches(TownVisualLayout.Roads, "Roads", RoadY);
            await BuildRegionsAsync();

            BakeNavMesh(surface);
        }

        private void EnsureMaterial()
        {
            if (sharedMaterial != null)
            {
                return;
            }

            Shader shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            sharedMaterial = new Material(shader) { name = "TownPlaceholder" };
        }

        private NavMeshSurface BuildGroundAndNav()
        {
            var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            ground.name = "TownGround";
            ground.transform.SetParent(transform, false);
            // Unity Plane is 10×10 m; scale to the 88×72 grass footprint.
            ground.transform.localScale = new Vector3(
                TownVisualLayout.GroundSize.x / 10f, 1f, TownVisualLayout.GroundSize.y / 10f);
            Paint(ground, TownPalette.Grass);

            // Bake only from the ground plane (Children = self + descendants), so placeholder
            // buildings — which sit outside this hierarchy — never punch holes in the nav floor.
            NavMeshSurface surface = ground.AddComponent<NavMeshSurface>();
            surface.collectObjects = CollectObjects.Children;
            surface.useGeometry = NavMeshCollectGeometry.RenderMeshes;
            return surface;
        }

        private void BakeNavMesh(NavMeshSurface surface)
        {
            if (surface == null)
            {
                return;
            }

            surface.BuildNavMesh();
            Debug.Log("[AgentTown] TownBuilder: NavMesh baked over town ground");
        }

        private void BuildGroundPatches(IReadOnlyList<GroundPatchDef> patches, string parentName, float y)
        {
            Transform parent = new GameObject(parentName).transform;
            parent.SetParent(transform, false);

            for (int i = 0; i < patches.Count; i++)
            {
                GroundPatchDef patch = patches[i];
                Vector3 center = WireCoordinateTransform.ToUnity(patch.WireX, 0.0, patch.WireZ);

                var slab = GameObject.CreatePrimitive(PrimitiveType.Cube);
                slab.name = $"{parentName}_{i}";
                slab.transform.SetParent(parent, false);
                slab.transform.position = new Vector3(center.x, y, center.z);
                slab.transform.localScale = new Vector3(
                    (float)patch.SizeX, SlabThickness, (float)patch.SizeZ);
                StripCollider(slab);
                Paint(slab, patch.Color);
            }
        }

        private async Task BuildRegionsAsync()
        {
            Dictionary<string, WireVec3> anchors = await LoadAnchorsAsync();
            regionAnchors.Clear();

            Transform buildingsParent = new GameObject("Buildings").transform;
            buildingsParent.SetParent(transform, false);
            Transform markersParent = new GameObject("Markers").transform;
            markersParent.SetParent(transform, false);

            foreach (RegionVisualDef region in TownVisualLayout.Regions)
            {
                if (!anchors.TryGetValue(region.RegionId, out WireVec3 anchor))
                {
                    Debug.LogWarning($"[AgentTown] TownBuilder: no anchor for region {region.RegionId}");
                    continue;
                }

                Vector3 anchorUnity = WireCoordinateTransform.ToUnity(anchor);
                regionAnchors[region.RegionId] = anchorUnity;

                SpawnRegionMarker(markersParent, region, anchorUnity);

                Transform regionParent = new GameObject(region.RegionId).transform;
                regionParent.SetParent(buildingsParent, false);

                for (int i = 0; i < region.Buildings.Length; i++)
                {
                    SpawnPlaceholder(regionParent, region.Buildings[i], anchor, region.ZoneColor, i);
                }
            }
        }

        private async Task<Dictionary<string, WireVec3>> LoadAnchorsAsync()
        {
            string json = await StreamingAssetsText.LoadAsync(RegionFixture);
            Dictionary<string, WireVec3> anchors = RegionPositions.Parse(json);
            if (anchors.Count == 0)
            {
                Debug.LogWarning("[AgentTown] TownBuilder: region fixture empty — buildings skipped");
            }

            return anchors;
        }

        private void SpawnPlaceholder(
            Transform parent, PlaceholderDef def, WireVec3 anchor, Color color, int index)
        {
            // Wire-space anchor + XZ offset, then the single §6.2 transform to Unity.
            Vector3 basePos = WireCoordinateTransform.ToUnity(
                anchor.X + def.OffsetX, 0.0, anchor.Z + def.OffsetZ);

            GetShapeDimensions(def.Shape, def.Scale, out Vector3 scale, out float heightOffset, out PrimitiveType primitive);

            var actor = GameObject.CreatePrimitive(primitive);
            actor.name = $"{parent.name}_{index}";
            actor.transform.SetParent(parent, false);
            actor.transform.position = new Vector3(basePos.x, heightOffset, basePos.z);
            // Wire yaw is right-handed; flip to match the §6.2 z-mirror.
            actor.transform.rotation = Quaternion.Euler(0f, -def.RotationYRad * Mathf.Rad2Deg, 0f);
            actor.transform.localScale = scale;
            StripCollider(actor);
            Paint(actor, color);
        }

        private void SpawnRegionMarker(Transform parent, RegionVisualDef region, Vector3 anchorUnity)
        {
            var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            marker.name = $"Region_{region.RegionId}";
            marker.transform.SetParent(parent, false);
            marker.transform.position = new Vector3(anchorUnity.x, MarkerHeight, anchorUnity.z);
            marker.transform.localScale = Vector3.one * 1.5f;
            StripCollider(marker);
            Paint(marker, region.ZoneColor);
        }

        private static void GetShapeDimensions(
            PlaceholderShape shape, float scale, out Vector3 localScale, out float heightOffset, out PrimitiveType primitive)
        {
            switch (shape)
            {
                case PlaceholderShape.Disc:
                    primitive = PrimitiveType.Cylinder;
                    localScale = new Vector3(1.2f * scale, 0.15f * scale, 1.2f * scale);
                    heightOffset = 0.15f * scale;
                    break;
                case PlaceholderShape.FlatProp:
                    primitive = PrimitiveType.Cube;
                    localScale = new Vector3(3.2f * scale, 0.5f * scale, 1.4f * scale);
                    heightOffset = 0.25f * scale;
                    break;
                case PlaceholderShape.Tower:
                    primitive = PrimitiveType.Cylinder;
                    localScale = new Vector3(2.4f * scale, 3.5f * scale, 2.4f * scale);
                    heightOffset = 3.5f * scale;
                    break;
                default: // Building
                    primitive = PrimitiveType.Cube;
                    localScale = new Vector3(2.8f * scale, 3.6f * scale, 2.8f * scale);
                    heightOffset = 1.8f * scale;
                    break;
            }
        }

        private void Paint(GameObject go, Color color)
        {
            if (!go.TryGetComponent(out Renderer renderer))
            {
                return;
            }

            renderer.sharedMaterial = sharedMaterial;
            var block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            renderer.SetPropertyBlock(block);
        }

        private static void StripCollider(GameObject go)
        {
            if (go.TryGetComponent(out Collider collider))
            {
                Destroy(collider);
            }
        }
    }
}
