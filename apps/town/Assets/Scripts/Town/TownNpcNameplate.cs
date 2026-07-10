using UnityEngine;
using UnityEngine.UI;

namespace AgentTown.Town
{
    /// <summary>
    /// World-space uGUI nameplate above an NPC (§7 exception). Shows name + Role · Mood subtitle.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownNpcNameplate : MonoBehaviour
    {
        private const float CanvasHeight = 2.35f;
        private const float CanvasScale = 0.012f;

        private Canvas canvas;
        private Text nameText;
        private Text subtitleText;
        private Image background;
        private bool selected;
        private float nextBillboardAt;

        public void EnsureBuilt()
        {
            if (canvas != null)
            {
                return;
            }

            var root = new GameObject("Nameplate");
            root.transform.SetParent(transform, false);
            root.transform.localPosition = new Vector3(0f, CanvasHeight, 0f);
            root.transform.localScale = Vector3.one * CanvasScale;

            canvas = root.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.worldCamera = Camera.main;

            var rt = root.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(220f, 56f);

            root.AddComponent<CanvasScaler>().dynamicPixelsPerUnit = 10f;

            var bgGo = new GameObject("Bg");
            bgGo.transform.SetParent(root.transform, false);
            background = bgGo.AddComponent<Image>();
            background.color = new Color(0.08f, 0.1f, 0.14f, 0.78f);
            var bgRt = bgGo.GetComponent<RectTransform>();
            bgRt.anchorMin = Vector2.zero;
            bgRt.anchorMax = Vector2.one;
            bgRt.offsetMin = Vector2.zero;
            bgRt.offsetMax = Vector2.zero;

            nameText = CreateLabel(root.transform, "Name", 22, FontStyle.Bold, new Vector2(0f, 10f));
            subtitleText = CreateLabel(root.transform, "Subtitle", 16, FontStyle.Normal, new Vector2(0f, -12f));
            subtitleText.color = new Color(0.78f, 0.82f, 0.9f, 1f);
        }

        public void SetContent(string displayName, string subtitle, bool isSelected)
        {
            EnsureBuilt();
            if (nameText != null)
            {
                nameText.text = string.IsNullOrEmpty(displayName) ? "—" : displayName;
            }

            if (subtitleText != null)
            {
                string line = string.IsNullOrEmpty(subtitle) ? "" : subtitle;
                subtitleText.text = line;
                subtitleText.gameObject.SetActive(!string.IsNullOrEmpty(line));
            }

            selected = isSelected;
            if (background != null)
            {
                background.color = selected
                    ? new Color(0.18f, 0.42f, 0.82f, 0.88f)
                    : new Color(0.08f, 0.1f, 0.14f, 0.78f);
            }
        }

        private void LateUpdate()
        {
            if (canvas == null)
            {
                return;
            }

            Camera cam = Camera.main;
            if (cam == null)
            {
                return;
            }

            float distance = Vector3.Distance(cam.transform.position, transform.position);
            bool show = selected || distance <= TownWatchPerf.NameplateHideDistance;
            if (canvas.enabled != show)
            {
                canvas.enabled = show;
            }

            if (!show || Time.unscaledTime < nextBillboardAt)
            {
                return;
            }

            nextBillboardAt = Time.unscaledTime + 0.12f;
            canvas.worldCamera = cam;
            Transform t = canvas.transform;
            t.rotation = Quaternion.LookRotation(t.position - cam.transform.position, Vector3.up);
        }

        private static Text CreateLabel(Transform parent, string name, int fontSize, FontStyle style, Vector2 anchoredPos)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var text = go.AddComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (text.font == null)
            {
                text.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            }

            text.fontSize = fontSize;
            text.fontStyle = style;
            text.alignment = TextAnchor.MiddleCenter;
            text.color = Color.white;
            text.horizontalOverflow = HorizontalWrapMode.Overflow;
            text.verticalOverflow = VerticalWrapMode.Overflow;
            text.raycastTarget = false;

            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = new Vector2(0f, 0.5f);
            rt.anchorMax = new Vector2(1f, 0.5f);
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = new Vector2(0f, 28f);
            rt.anchoredPosition = anchoredPos;
            return text;
        }
    }
}
