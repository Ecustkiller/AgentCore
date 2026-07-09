using System.Collections.Generic;
using AgentTown.Simulation;
using UnityEngine;

namespace AgentTown.Town
{
    /// <summary>
    /// Spawns and updates NPCs from <see cref="SimulationSession"/> positions (§7 NpcLayer, faithful
    /// port of the retired UE <c>TownNpcManager</c>). Reads the session's authoritative Unity
    /// positions and adds the §6.5 visual spawn offset (§4.3 step 4) so co-located residents don't
    /// stack — offset only, never written back to the backend.
    ///
    /// <para>Live snapshots drive <c>NavMeshAgent.SetDestination</c>; replay snaps the transform
    /// (§4.2). Colours are assigned deterministically on first sight via <see cref="TownPalette"/>.</para>
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownNpcManager : MonoBehaviour
    {
        private readonly Dictionary<string, TownNpc> npcs = new();
        private readonly Dictionary<string, int> colorIndices = new();

        private SimulationSession session;
        private Material sharedMaterial;
        private Transform container;

        /// <summary>Point the manager at a session (defaults to the singleton) and its NPC material.</summary>
        public void Bind(SimulationSession target, Material npcMaterial)
        {
            Unsubscribe();
            session = target;
            sharedMaterial = npcMaterial;
            Subscribe();
            SyncNpcs();
        }

        private void OnEnable()
        {
            session ??= SimulationSession.Instance;
            Subscribe();
            SyncNpcs();
        }

        private void OnDisable() => Unsubscribe();

        private void Subscribe()
        {
            if (session != null)
            {
                session.OnSnapshotApplied += SyncNpcs;
            }
        }

        private void Unsubscribe()
        {
            if (session != null)
            {
                session.OnSnapshotApplied -= SyncNpcs;
            }
        }

        /// <summary>
        /// Seed NPCs at their home region anchors before the first snapshot (mirrors Desktop
        /// <c>seedTownSpawnsIfNeeded</c>) so the town is populated on arrival. Live/replay snapshots
        /// then take over via <see cref="SyncNpcs"/>.
        /// </summary>
        public void SeedFromPersonas(IReadOnlyDictionary<string, Vector3> regionAnchors)
        {
            if (regionAnchors == null)
            {
                return;
            }

            foreach (LocalPersona persona in TownPersonas.All)
            {
                if (string.IsNullOrEmpty(persona.Home) || !regionAnchors.TryGetValue(persona.Home, out Vector3 anchor))
                {
                    continue;
                }

                Vector3 spawn = anchor + TownPersonas.UnitySpawnOffset(persona.AgentId);
                TownNpc npc = GetOrCreate(persona.AgentId);
                npc.ApplyGoal(spawn, snap: true);
            }
        }

        private void SyncNpcs()
        {
            if (session == null)
            {
                return;
            }

            IReadOnlyDictionary<string, Vector3> positions = session.AgentUnityPositions;
            // No snapshot yet — keep any seeded NPCs rather than tearing them down.
            if (positions.Count == 0)
            {
                return;
            }

            bool snap = !session.IsLive;
            var seen = new HashSet<string>();

            foreach (KeyValuePair<string, Vector3> pair in positions)
            {
                seen.Add(pair.Key);
                Vector3 target = pair.Value + TownPersonas.UnitySpawnOffset(pair.Key);
                TownNpc npc = GetOrCreate(pair.Key);
                npc.ApplyGoal(target, snap);
            }

            RemoveStale(seen);
        }

        private TownNpc GetOrCreate(string agentId)
        {
            if (npcs.TryGetValue(agentId, out TownNpc existing) && existing != null)
            {
                return existing;
            }

            EnsureContainer();

            var go = new GameObject($"NPC_{agentId}");
            go.transform.SetParent(container, false);

            var npc = go.AddComponent<TownNpc>();
            npc.Initialize(agentId, sharedMaterial);
            npc.ApplyTint(TownPalette.NpcColor(ColorIndexFor(agentId)));

            npcs[agentId] = npc;
            return npc;
        }

        private int ColorIndexFor(string agentId)
        {
            if (!colorIndices.TryGetValue(agentId, out int index))
            {
                index = colorIndices.Count;
                colorIndices[agentId] = index;
            }

            return index;
        }

        private void RemoveStale(HashSet<string> seen)
        {
            var stale = new List<string>();
            foreach (KeyValuePair<string, TownNpc> pair in npcs)
            {
                if (!seen.Contains(pair.Key))
                {
                    stale.Add(pair.Key);
                    if (pair.Value != null)
                    {
                        Destroy(pair.Value.gameObject);
                    }
                }
            }

            foreach (string id in stale)
            {
                npcs.Remove(id);
            }
        }

        private void EnsureContainer()
        {
            if (container == null)
            {
                container = new GameObject("NPCs").transform;
                container.SetParent(transform, false);
            }
        }
    }
}
