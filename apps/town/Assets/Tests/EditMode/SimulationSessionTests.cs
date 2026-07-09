using AgentTown.Simulation;
using NUnit.Framework;
using UnityEngine;

namespace AgentTown.Tests
{
    /// <summary>
    /// EditMode checks for the engine-agnostic session pipeline (§4.3). Mirrors the retired
    /// UE ApplySnapshot test: an agent at wire 市场 <c>(24,0,0)</c> lands at Unity
    /// <c>(24,0,0)</c>, and cached frames are addressable for replay.
    /// </summary>
    public sealed class SimulationSessionTests
    {
        [Test]
        public void ApplySnapshot_TransformsAgentPositions()
        {
            var session = new SimulationSession();
            session.Reset();

            var snapshot = new SimTickSnapshot
            {
                Tick = 1,
                Hour = 9,
            };
            snapshot.Agents["agent-1"] = new SimAgentState
            {
                AgentId = "agent-1",
                Name = "林小梅",
                Location = "市场",
                Position = new WireVec3(24.0, 0.0, 0.0),
            };

            session.ApplySnapshot(snapshot);

            Assert.AreEqual(1, session.Tick);
            Assert.AreEqual(9, session.Hour);
            Assert.IsTrue(session.AgentUnityPositions.ContainsKey("agent-1"));

            Vector3 pos = session.AgentUnityPositions["agent-1"];
            Assert.AreEqual(24f, pos.x, 1e-4f, "agent X");
            Assert.AreEqual(0f, pos.y, 1e-4f, "agent Y");
            Assert.AreEqual(0f, pos.z, 1e-4f, "agent Z");
        }

        [Test]
        public void ApplySnapshot_CachesFrameForReplay()
        {
            var session = new SimulationSession();
            session.Reset();

            var snapshot = new SimTickSnapshot { Tick = 3, Hour = 11 };
            session.ApplySnapshot(snapshot);

            Assert.IsTrue(session.TickCache.ContainsKey(3), "tick 3 cached");
            Assert.AreEqual(3, session.DisplayTick);
        }
    }
}
