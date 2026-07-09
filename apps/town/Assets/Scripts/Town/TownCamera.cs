using AgentTown.Simulation;
using UnityEngine;

namespace AgentTown.Town
{
    /// <summary>
    /// Phase 1 bird's-eye observer camera (§7 CameraRig). Frames the whole town from the Desktop
    /// reference angle — position <c>TOWN_CAMERA_POS</c> looking at <c>TOWN_VIEW_CENTER</c>, both
    /// transformed from wire space (§6.2). Per-agent tracking is Phase 2 (§11) and intentionally
    /// not implemented here.
    /// </summary>
    [RequireComponent(typeof(Camera))]
    [DisallowMultipleComponent]
    public sealed class TownCamera : MonoBehaviour
    {
        private void Start() => Frame();

        /// <summary>Place the camera at the fixed bird's-eye vantage and look at the town centre.</summary>
        public void Frame()
        {
            Vector3 viewCenter = WireCoordinateTransform.ToUnity(
                TownVisualLayout.ViewCenterWire.x,
                TownVisualLayout.ViewCenterWire.y,
                TownVisualLayout.ViewCenterWire.z);
            Vector3 cameraPos = WireCoordinateTransform.ToUnity(
                TownVisualLayout.CameraWire.x,
                TownVisualLayout.CameraWire.y,
                TownVisualLayout.CameraWire.z);

            transform.position = cameraPos;
            transform.rotation = Quaternion.LookRotation((viewCenter - cameraPos).normalized, Vector3.up);
        }
    }
}
