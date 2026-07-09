using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AgentTown.Simulation
{
    /// <summary>
    /// Loads <c>simulation-region-positions.json</c> — the single source for the 7 town
    /// region anchors (§6.3). Values are wire-space; convert with
    /// <see cref="WireCoordinateTransform.ToUnity(WireVec3)"/> at render time.
    ///
    /// <para>The file-based loader targets the Editor / desktop standalone build (direct
    /// filesystem access). WebGL cannot read StreamingAssets as files — a UnityWebRequest
    /// loader is required there (see the Editor-wiring checklist).</para>
    /// </summary>
    public static class RegionPositions
    {
        public const string FixtureFileName = "simulation-region-positions.json";

        public static string DefaultFixturePath =>
            Path.Combine(Application.streamingAssetsPath, "Fixtures", FixtureFileName);

        /// <summary>Parse region name → wire position from raw JSON. Returns an empty map on malformed input.</summary>
        public static Dictionary<string, WireVec3> Parse(string json)
        {
            var result = new Dictionary<string, WireVec3>();
            if (string.IsNullOrWhiteSpace(json))
            {
                return result;
            }

            JObject root;
            try
            {
                root = JObject.Parse(json);
            }
            catch (Newtonsoft.Json.JsonException)
            {
                return result;
            }

            if (root["regions"] is not JObject regions)
            {
                return result;
            }

            foreach (var pair in regions)
            {
                if (pair.Value is not JObject pos)
                {
                    continue;
                }

                result[pair.Key] = new WireVec3(
                    pos.Value<double?>("x") ?? 0.0,
                    pos.Value<double?>("y") ?? 0.0,
                    pos.Value<double?>("z") ?? 0.0);
            }

            return result;
        }

        /// <summary>Load + parse from disk (defaults to the StreamingAssets copy).</summary>
        public static Dictionary<string, WireVec3> LoadFromFile(string path = null)
        {
            var target = string.IsNullOrEmpty(path) ? DefaultFixturePath : path;
            if (!File.Exists(target))
            {
                Debug.LogWarning($"[AgentTown] Region fixture not found: {target}");
                return new Dictionary<string, WireVec3>();
            }

            return Parse(File.ReadAllText(target));
        }
    }
}
