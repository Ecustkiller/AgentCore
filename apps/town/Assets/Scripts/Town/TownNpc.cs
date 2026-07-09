using UnityEngine;
using UnityEngine.AI;

namespace AgentTown.Town
{
    /// <summary>
    /// One resident NPC (§7 NpcLayer). Placeholder capsule body + <see cref="NavMeshAgent"/> for
    /// live pathing, with an <see cref="Animator"/> component attached but no controller yet — the
    /// real Xbot skinned mesh + animator controller are an Editor step (§7 NPC rendering). Per-agent
    /// colour is applied through a <see cref="MaterialPropertyBlock"/> so all NPCs share one material.
    ///
    /// <para>Live: <see cref="ApplyGoal"/> drives <c>NavMeshAgent.SetDestination</c>. Replay: it snaps
    /// the transform via <c>NavMeshAgent.Warp</c> (§4.2 / §4.3 step 3).</para>
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownNpc : MonoBehaviour
    {
        private const float BodyHeight = 1.8f;
        private const float SampleRadius = 4f;

        private NavMeshAgent agent;
        private Renderer bodyRenderer;
        private MaterialPropertyBlock propertyBlock;

        public string AgentId { get; private set; } = "";

        /// <summary>Build the body, nav agent and (placeholder) animator. Call once right after spawn.</summary>
        public void Initialize(string agentId, Material sharedMaterial)
        {
            AgentId = agentId;

            agent = gameObject.AddComponent<NavMeshAgent>();
            agent.speed = 3.5f;
            agent.angularSpeed = 540f;
            agent.acceleration = 12f;
            agent.radius = 0.35f;
            agent.height = BodyHeight;
            agent.stoppingDistance = 0.25f;
            agent.autoBraking = true;

            var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            body.name = "Body";
            body.transform.SetParent(transform, false);
            body.transform.localPosition = new Vector3(0f, BodyHeight / 2f, 0f);
            body.transform.localScale = new Vector3(0.5f, BodyHeight / 2f, 0.5f);
            if (body.TryGetComponent(out Collider collider))
            {
                Destroy(collider);
            }

            bodyRenderer = body.GetComponent<Renderer>();
            if (bodyRenderer != null && sharedMaterial != null)
            {
                bodyRenderer.sharedMaterial = sharedMaterial;
            }

            // Animator hook for the future skinned Xbot; controller assigned in Editor (§7).
            body.AddComponent<Animator>();
        }

        public void ApplyTint(Color color)
        {
            if (bodyRenderer == null)
            {
                return;
            }

            propertyBlock ??= new MaterialPropertyBlock();
            bodyRenderer.GetPropertyBlock(propertyBlock);
            propertyBlock.SetColor("_BaseColor", color);
            propertyBlock.SetColor("_Color", color);
            bodyRenderer.SetPropertyBlock(propertyBlock);
        }

        /// <summary>Move toward <paramref name="worldPosition"/>: teleport when <paramref name="snap"/> (replay), else path (live).</summary>
        public void ApplyGoal(Vector3 worldPosition, bool snap)
        {
            Vector3 target = SampleOnNavMesh(worldPosition);

            if (agent == null || !agent.enabled)
            {
                transform.position = target;
                return;
            }

            if (snap || !agent.isOnNavMesh)
            {
                agent.Warp(target);
                if (agent.isOnNavMesh)
                {
                    agent.ResetPath();
                }

                return;
            }

            agent.SetDestination(target);
        }

        private static Vector3 SampleOnNavMesh(Vector3 worldPosition)
        {
            return NavMesh.SamplePosition(worldPosition, out NavMeshHit hit, SampleRadius, NavMesh.AllAreas)
                ? hit.position
                : worldPosition;
        }
    }
}
