using System.Collections.Generic;
using AgentTown.Simulation;
using AgentTown.Town;
using NUnit.Framework;

namespace AgentTown.Tests
{
    /// <summary>
    /// EditMode checks for the static town layout data (§6.3, §15.2 step 4). Guards that the
    /// runtime builder covers exactly the 7 authoritative regions from the fixture and that every
    /// region / road / zone table is populated.
    /// </summary>
    public sealed class TownVisualLayoutTests
    {
        private static readonly string[] ExpectedRegions =
        {
            "广场", "市场", "餐厅", "面包店", "公园", "住宅区", "镇政厅",
        };

        [Test]
        public void Regions_CoverAllSevenAnchors()
        {
            Assert.AreEqual(ExpectedRegions.Length, TownVisualLayout.Regions.Length, "region count");

            var ids = new HashSet<string>();
            foreach (RegionVisualDef region in TownVisualLayout.Regions)
            {
                ids.Add(region.RegionId);
                Assert.IsNotEmpty(region.Buildings, $"region {region.RegionId} has placeholders");
            }

            foreach (string expected in ExpectedRegions)
            {
                Assert.IsTrue(ids.Contains(expected), $"layout covers region {expected}");
            }
        }

        [Test]
        public void Regions_MatchFixtureAnchorKeys()
        {
            Dictionary<string, WireVec3> anchors = RegionPositions.LoadFromFile();
            Assert.IsNotEmpty(anchors, "region fixture loaded");

            foreach (RegionVisualDef region in TownVisualLayout.Regions)
            {
                Assert.IsTrue(anchors.ContainsKey(region.RegionId), $"fixture has anchor for {region.RegionId}");
            }
        }

        [Test]
        public void RoadsAndZones_ArePopulated()
        {
            Assert.IsNotEmpty(TownVisualLayout.Roads, "road patches");
            Assert.IsNotEmpty(TownVisualLayout.Zones, "zone patches");
            Assert.AreEqual(TownVisualLayout.Regions.Length, TownVisualLayout.Zones.Length, "one lot per region");
            Assert.Greater(TownVisualLayout.GroundSize.x, 0f);
            Assert.Greater(TownVisualLayout.GroundSize.y, 0f);
        }
    }
}
