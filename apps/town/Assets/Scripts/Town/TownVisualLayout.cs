using UnityEngine;

namespace AgentTown.Town
{
    public enum PlaceholderShape
    {
        /// <summary>Tall box — houses / shops (UE <c>Cube</c>).</summary>
        Building,

        /// <summary>Short disc — parasols / benches (UE <c>Cylinder</c>).</summary>
        Disc,

        /// <summary>Low slab — stalls / awnings (UE <c>FlatCube</c>).</summary>
        FlatProp,

        /// <summary>Tall column — civic towers (UE <c>TallCylinder</c>).</summary>
        Tower,
    }

    /// <summary>One placeholder building, positioned by a wire-space XZ offset from its region anchor.</summary>
    public readonly struct PlaceholderDef
    {
        public readonly double OffsetX;
        public readonly double OffsetZ;
        public readonly float RotationYRad;
        public readonly float Scale;
        public readonly PlaceholderShape Shape;

        public PlaceholderDef(double offsetX, double offsetZ, float rotationYRad, float scale, PlaceholderShape shape)
        {
            OffsetX = offsetX;
            OffsetZ = offsetZ;
            RotationYRad = rotationYRad;
            Scale = scale;
            Shape = shape;
        }
    }

    /// <summary>Per-region zone tint + placeholder cluster.</summary>
    public readonly struct RegionVisualDef
    {
        public readonly string RegionId;
        public readonly Color ZoneColor;
        public readonly PlaceholderDef[] Buildings;

        public RegionVisualDef(string regionId, Color zoneColor, PlaceholderDef[] buildings)
        {
            RegionId = regionId;
            ZoneColor = zoneColor;
            Buildings = buildings;
        }
    }

    /// <summary>A flat coloured lot / road quad in wire-space (centre + size in wire metres).</summary>
    public readonly struct GroundPatchDef
    {
        public readonly double WireX;
        public readonly double WireZ;
        public readonly double SizeX;
        public readonly double SizeZ;
        public readonly Color Color;

        public GroundPatchDef(double wireX, double wireZ, double sizeX, double sizeZ, Color color)
        {
            WireX = wireX;
            WireZ = wireZ;
            SizeX = sizeX;
            SizeZ = sizeZ;
            Color = color;
        }
    }

    /// <summary>
    /// Static town layout data — the placeholder buildings, roads, and zone lots for the 7 regions.
    /// Ported from the retired UE <c>TownBuildingSpawner</c> (which itself distilled the Desktop
    /// R3F <c>regionLayout.ts</c> Kenney arrangement into engine primitives). Positions are wire
    /// XZ offsets from each region anchor (§6.3); <see cref="TownBuilder"/> transforms them to
    /// Unity space via <c>WireCoordinateTransform</c>.
    /// </summary>
    public static class TownVisualLayout
    {
        private const float Pi = Mathf.PI;

        private static PlaceholderDef P(
            double dx, double dz, float rotY = 0f, float scale = 1f, PlaceholderShape shape = PlaceholderShape.Building)
            => new(dx, dz, rotY, scale, shape);

        private static GroundPatchDef Patch(double x, double z, double w, double d, Color color)
            => new(x, z, w, d, color);

        private static readonly Color ParkPath = new(0.54f, 0.58f, 0.53f);

        /// <summary>Roads / paths (Desktop main artery + branch streets), drawn above the zone lots.</summary>
        public static readonly GroundPatchDef[] Roads =
        {
            Patch(8, 0, 72, 5, TownPalette.Road),
            Patch(0, 6, 5, 52, TownPalette.Road),
            Patch(24, 0, 14, 4, TownPalette.RoadAccent),
            Patch(30, 6, 18, 4, TownPalette.RoadAccent),
            Patch(36, 8, 4, 12, TownPalette.RoadAccent),
            Patch(24, -6, 14, 4, TownPalette.RoadAccent),
            Patch(24, -10, 4, 10, TownPalette.RoadAccent),
            Patch(6, 18, 4, 16, TownPalette.RoadAccent),
            Patch(12, 22, 12, 4, TownPalette.RoadAccent),
            Patch(-6, -5, 16, 4, TownPalette.RoadAccent),
            Patch(-12, -8, 4, 10, TownPalette.RoadAccent),
            Patch(-9, 6, 14, 3, ParkPath),
            Patch(-18, 4, 3, 12, ParkPath),
        };

        /// <summary>Per-region ground lots, laid over the grass base and under the roads.</summary>
        public static readonly GroundPatchDef[] Zones =
        {
            Patch(0, 0, 12, 12, new Color(0.72f, 0.77f, 0.81f)),
            Patch(24, 0, 14, 12, new Color(0.77f, 0.72f, 0.66f)),
            Patch(36, 12, 12, 10, new Color(0.83f, 0.77f, 0.69f)),
            Patch(24, -12, 14, 10, new Color(0.69f, 0.72f, 0.75f)),
            Patch(12, 24, 16, 14, new Color(0.66f, 0.77f, 0.63f)),
            Patch(-12, -10, 14, 12, new Color(0.69f, 0.72f, 0.78f)),
            Patch(-18, 6, 16, 12, new Color(0.42f, 0.68f, 0.42f)),
        };

        /// <summary>The 7 authoritative gameplay regions with placeholder clusters (§6.3).</summary>
        public static readonly RegionVisualDef[] Regions =
        {
            new("广场", new Color(0.61f, 0.64f, 0.68f), new[]
            {
                P(-5, -5, Pi / 2f), P(5, -5, -Pi / 2f), P(-5, 5, Pi), P(5, 5),
                P(0, -5, Pi, 0.95f), P(0, 5, 0f, 0.95f), P(-5, 0, Pi / 2f, 0.9f), P(5, 0, -Pi / 2f, 0.9f),
                P(-2, 1, 0f, 0.8f, PlaceholderShape.Disc), P(2, -1, 0.8f, 0.8f, PlaceholderShape.Disc),
                P(0, 2, 1.5f, 0.8f, PlaceholderShape.Disc), P(-1, -2, 0.3f, 0.9f, PlaceholderShape.FlatProp),
            }),
            new("市场", new Color(0.85f, 0.47f, 0.02f), new[]
            {
                P(-5, -4, Pi), P(-2, -4, Pi), P(1, -4, Pi, 0.95f), P(4, -4, Pi, 0.95f),
                P(-5, 4), P(-2, 4, 0f, 0.95f), P(1, 4, 0f, 0.95f), P(4, 4, 0f, 0.95f),
                P(-6, 0, Pi / 2f, 0.9f), P(6, -1, -Pi / 2f, 0.9f),
                P(0, 1, Pi / 6f, 1.1f, PlaceholderShape.FlatProp), P(-3, 0, Pi / 2f, 1.0f, PlaceholderShape.FlatProp),
                P(3, 0, -Pi / 2f, 1.0f, PlaceholderShape.FlatProp), P(3, 2, 0f, 0.85f, PlaceholderShape.Disc),
                P(-3, -2, 1.0f, 0.85f, PlaceholderShape.Disc),
            }),
            new("餐厅", new Color(0.86f, 0.15f, 0.15f), new[]
            {
                P(0, 2, -Pi / 5f, 1.15f), P(-4, -1, Pi / 3f, 1.05f), P(4, -1, -Pi / 3f, 1.0f),
                P(-4, 3, Pi / 4f, 0.95f), P(4, 3, -Pi / 4f, 0.95f), P(0, -4, Pi, 0.9f),
                P(-5, -4, 3f * Pi / 4f, 0.88f),
                P(-2, 4, 0.5f, 0.8f, PlaceholderShape.Disc), P(1, 4, 1.2f, 0.8f, PlaceholderShape.Disc),
                P(3, 3, 2.0f, 0.8f, PlaceholderShape.Disc), P(2, -3, Pi, 0.85f, PlaceholderShape.FlatProp),
            }),
            new("面包店", new Color(0.63f, 0.38f, 0.03f), new[]
            {
                P(-4, 0, Pi / 2f, 1.1f), P(4, 0, -Pi / 2f, 1.1f), P(0, -4, Pi, 1.05f),
                P(-2, 3, 0f, 0.95f), P(2, 3, -Pi / 6f, 0.9f), P(-5, -3, Pi / 4f, 0.9f), P(5, -3, -Pi / 4f, 0.9f),
                P(0, 4, 0f, 0.88f),
                P(3, 3, -Pi / 6f, 0.9f, PlaceholderShape.FlatProp), P(-3, 3, Pi / 3f, 0.85f, PlaceholderShape.FlatProp),
                P(1, -2, 0f, 0.8f, PlaceholderShape.Disc),
            }),
            new("住宅区", new Color(0.23f, 0.51f, 0.96f), new[]
            {
                P(-4, -5, Pi, 0.95f), P(-1, -5, Pi, 0.95f), P(2, -5, Pi, 0.93f), P(5, -5, Pi, 0.93f),
                P(-5, -2, Pi / 2f, 0.95f), P(-2, -2, Pi / 4f, 0.93f), P(1, -2, -Pi / 4f, 0.93f), P(4, -2, -Pi / 2f, 0.95f),
                P(-3, 1, Pi / 2f, 0.93f), P(0, 1, 0f, 0.95f), P(3, 1, -Pi / 2f, 0.93f),
                P(-4, 4, 3f * Pi / 4f, 0.93f), P(-1, 4, 0f, 0.95f), P(2, 4, 0f, 0.93f), P(5, 4, -3f * Pi / 4f, 0.93f),
            }),
            new("镇政厅", new Color(0.39f, 0.40f, 0.95f), new[]
            {
                P(0, -2, 0f, 1.25f, PlaceholderShape.Tower), P(-5, 0, Pi / 6f, 1.05f, PlaceholderShape.Tower),
                P(5, 0, -Pi / 6f, 1.0f, PlaceholderShape.Tower),
                P(-4, 4, Pi, 0.95f), P(4, 4, Pi, 0.95f), P(-5, -4, Pi / 3f, 0.9f), P(5, -4, -Pi / 3f, 0.9f),
                P(0, 4, 0f, 0.85f, PlaceholderShape.Tower),
                P(-2, 3, 0f, 0.75f, PlaceholderShape.Disc), P(2, 3, 1.2f, 0.75f, PlaceholderShape.Disc),
            }),
            new("公园", new Color(0.13f, 0.77f, 0.37f), new[]
            {
                P(-5, 2, 0f, 0.85f, PlaceholderShape.Disc), P(2, 1, 1.2f, 0.85f, PlaceholderShape.Disc),
                P(-1, -3, 0.4f, 0.85f, PlaceholderShape.Disc), P(4, -1, 2.1f, 0.85f, PlaceholderShape.Disc),
                P(-3, -1, 0.6f, 0.85f, PlaceholderShape.Disc), P(1, 4, 1.8f, 0.85f, PlaceholderShape.Disc),
                P(5, 3, 2.5f, 0.8f, PlaceholderShape.Disc), P(0, 0, 0.9f, 0.8f, PlaceholderShape.Disc),
                P(-4, -4, Pi / 4f, 0.9f, PlaceholderShape.FlatProp), P(3, -3, -Pi / 3f, 0.9f, PlaceholderShape.FlatProp),
                P(-2, 4, Pi / 6f, 0.85f, PlaceholderShape.FlatProp),
                P(-6, -4, Pi / 3f, 0.8f), P(6, 4, -Pi / 4f, 0.75f),
            }),
        };

        /// <summary>Grass base footprint in wire metres (Desktop BASE_GRASS_SIZE 88×72).</summary>
        public static readonly Vector2 GroundSize = new(88f, 72f);

        /// <summary>Approx town centroid for camera framing (Desktop TOWN_VIEW_CENTER, wire space).</summary>
        public static readonly Vector3 ViewCenterWire = new(9f, 0f, 5f);

        /// <summary>Bird's-eye camera position (Desktop TOWN_CAMERA_POS, wire space).</summary>
        public static readonly Vector3 CameraWire = new(48f, 40f, 44f);
    }
}
