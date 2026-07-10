using AgentTown.Simulation;
using UnityEngine;

namespace AgentTown.Town
{
    /// <summary>
    /// Drives directional sun + ambient / fog / sky from <see cref="SimulationSession.Hour"/>
    /// (0–23), porting the Desktop <c>dayNightPaletteForHour</c> keyframes into Unity.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TownDayNight : MonoBehaviour
    {
        private struct Keyframe
        {
            public int Hour;
            public Color Background;
            public Color Fog;
            public float AmbientIntensity;
            public Color AmbientColor;
            public Color HemiSky;
            public Color HemiGround;
            public float HemiIntensity;
            public Color SunColor;
            public float SunIntensity;
            public Vector3 SunPosition;
        }

        private static readonly Keyframe[] Keyframes =
        {
            new Keyframe
            {
                Hour = 0,
                Background = Hex("#0a1228"), Fog = Hex("#0a1228"),
                AmbientIntensity = 0.12f, AmbientColor = Hex("#8a9ec8"),
                HemiSky = Hex("#1a2848"), HemiGround = Hex("#0a1020"), HemiIntensity = 0.08f,
                SunColor = Hex("#6a7aaa"), SunIntensity = 0.05f, SunPosition = new Vector3(-8f, 4f, -6f),
            },
            new Keyframe
            {
                Hour = 5,
                Background = Hex("#3a4a6a"), Fog = Hex("#4a5a78"),
                AmbientIntensity = 0.28f, AmbientColor = Hex("#c8b8a8"),
                HemiSky = Hex("#8a9ab8"), HemiGround = Hex("#2a3040"), HemiIntensity = 0.18f,
                SunColor = Hex("#ffb878"), SunIntensity = 0.35f, SunPosition = new Vector3(6f, 6f, -10f),
            },
            new Keyframe
            {
                Hour = 8,
                Background = Hex("#8ec4f0"), Fog = Hex("#9ec8e8"),
                AmbientIntensity = 0.72f, AmbientColor = Hex("#fff8f0"),
                HemiSky = Hex("#fff4e8"), HemiGround = Hex("#6a8fbf"), HemiIntensity = 0.35f,
                SunColor = Hex("#fff6e8"), SunIntensity = 1.35f, SunPosition = new Vector3(14f, 22f, 10f),
            },
            new Keyframe
            {
                Hour = 12,
                Background = Hex("#9ed0f8"), Fog = Hex("#a8d4f0"),
                AmbientIntensity = 0.78f, AmbientColor = Hex("#ffffff"),
                HemiSky = Hex("#ffffff"), HemiGround = Hex("#7aa0c8"), HemiIntensity = 0.38f,
                SunColor = Hex("#fffef8"), SunIntensity = 1.5f, SunPosition = new Vector3(0f, 28f, 8f),
            },
            new Keyframe
            {
                Hour = 17,
                Background = Hex("#e8a878"), Fog = Hex("#d89870"),
                AmbientIntensity = 0.55f, AmbientColor = Hex("#ffe8d0"),
                HemiSky = Hex("#ffd0a0"), HemiGround = Hex("#6a7088"), HemiIntensity = 0.28f,
                SunColor = Hex("#ffb060"), SunIntensity = 0.95f, SunPosition = new Vector3(-16f, 10f, 12f),
            },
            new Keyframe
            {
                Hour = 20,
                Background = Hex("#2a3858"), Fog = Hex("#2a3858"),
                AmbientIntensity = 0.22f, AmbientColor = Hex("#a8b0c8"),
                HemiSky = Hex("#485878"), HemiGround = Hex("#1a2030"), HemiIntensity = 0.12f,
                SunColor = Hex("#c08060"), SunIntensity = 0.15f, SunPosition = new Vector3(-12f, 5f, 8f),
            },
        };

        private SimulationSession session;
        private Light sun;
        private Light hemi;
        private int lastHour = int.MinValue;
        private bool lastStorm;
        private bool lastFestival;

        public void Bind(SimulationSession target, Light directionalSun)
        {
            Unsubscribe();
            session = target;
            sun = directionalSun;
            EnsureHemi();
            Subscribe();
            ApplyHour(session?.Hour ?? 12);
        }

        private void OnEnable()
        {
            session ??= SimulationSession.Instance;
            Subscribe();
            ApplyHour(session.Hour);
        }

        private void OnDisable() => Unsubscribe();

        private void LateUpdate()
        {
            if (session == null)
            {
                return;
            }

            bool storm = session.Modifiers != null && session.Modifiers.StormActive;
            bool festival = session.Modifiers != null && session.Modifiers.FestivalActive;
            if (session.Hour != lastHour || storm != lastStorm || festival != lastFestival)
            {
                ApplyHour(session.Hour);
            }
        }

        private void Subscribe()
        {
            if (session != null)
            {
                session.OnSnapshotApplied += HandleSnapshot;
            }
        }

        private void Unsubscribe()
        {
            if (session != null)
            {
                session.OnSnapshotApplied -= HandleSnapshot;
            }
        }

        private void HandleSnapshot() => ApplyHour(session.Hour);

        private void EnsureHemi()
        {
            if (hemi != null)
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                hemi.enabled = false;
                hemi = null;
#else
                return;
#endif
            }

            foreach (Light existing in FindObjectsByType<Light>(FindObjectsSortMode.None))
            {
                if (existing.type == LightType.Point && existing.name == "TownHemiProxy")
                {
#if UNITY_WEBGL && !UNITY_EDITOR
                    existing.enabled = false;
#else
                    hemi = existing;
                    return;
#endif
                }
            }

            // URP has no HemisphereLight; approximate with a soft upward point + ambient.
            // WebGL: skip the point light — additional pixel lights are a common FPS cliff;
            // flat ambient from ApplyHour already carries the sky/ground tint.
#if UNITY_WEBGL && !UNITY_EDITOR
            return;
#else
            var go = new GameObject("TownHemiProxy");
            go.transform.SetParent(transform, false);
            go.transform.position = new Vector3(0f, 40f, 0f);
            hemi = go.AddComponent<Light>();
            hemi.type = LightType.Point;
            hemi.range = 200f;
            hemi.shadows = LightShadows.None;
#endif
        }

        private void ApplyHour(int hour)
        {
            lastHour = hour;
            lastStorm = session != null && session.Modifiers != null && session.Modifiers.StormActive;
            lastFestival = session != null && session.Modifiers != null && session.Modifiers.FestivalActive;

            Keyframe palette = PaletteForHour(hour);
            palette = ApplyModifierTint(palette, lastStorm, lastFestival);

            if (Camera.main != null)
            {
                Camera.main.backgroundColor = palette.Background;
            }

            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = palette.Fog;
#if UNITY_WEBGL && !UNITY_EDITOR
            // Trilight ambient (no extra pixel lights) — Lit buildings/nature get sky/ground
            // separation without soft shadows. Slightly dialed ambient leaves room for sun N·L.
            float amb = palette.AmbientIntensity * 0.82f;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = palette.HemiSky * amb;
            RenderSettings.ambientEquatorColor =
                Color.Lerp(palette.AmbientColor, palette.HemiSky, 0.35f) * amb;
            RenderSettings.ambientGroundColor = palette.HemiGround * amb;
            // Shorter fog range reduces far fill without hiding the town footprint.
            RenderSettings.fogStartDistance = 55f;
            RenderSettings.fogEndDistance = 110f;
#else
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = palette.AmbientColor * palette.AmbientIntensity;
            RenderSettings.fogStartDistance = 100f;
            RenderSettings.fogEndDistance = 220f;
#endif

            if (sun != null)
            {
                sun.color = palette.SunColor;
                sun.intensity = palette.SunIntensity;
                sun.transform.position = palette.SunPosition;
                if (palette.SunPosition.sqrMagnitude > 0.01f)
                {
                    sun.transform.rotation = Quaternion.LookRotation(-palette.SunPosition.normalized, Vector3.up);
                }
            }

            if (hemi != null)
            {
                hemi.color = Color.Lerp(palette.HemiSky, palette.HemiGround, 0.35f);
                hemi.intensity = palette.HemiIntensity * 8f;
            }
        }

        /// <summary>Blend storm / festival into the day-night palette (Desktop <c>worldModifierPalette</c>).</summary>
        private static Keyframe ApplyModifierTint(Keyframe basePalette, bool storm, bool festival)
        {
            Keyframe next = basePalette;
            if (storm)
            {
                next.Background = Color.Lerp(next.Background, Hex("#1a2840"), 0.55f);
                next.Fog = Color.Lerp(next.Fog, Hex("#2a3850"), 0.65f);
                next.AmbientIntensity = Mathf.Lerp(next.AmbientIntensity, 0.18f, 0.6f);
                next.AmbientColor = Color.Lerp(next.AmbientColor, Hex("#8a9ab8"), 0.5f);
                next.HemiSky = Color.Lerp(next.HemiSky, Hex("#4a5878"), 0.55f);
                next.HemiGround = Color.Lerp(next.HemiGround, Hex("#1a2030"), 0.45f);
                next.HemiIntensity = Mathf.Lerp(next.HemiIntensity, 0.1f, 0.5f);
                next.SunColor = Color.Lerp(next.SunColor, Hex("#9aa8c0"), 0.65f);
                next.SunIntensity = Mathf.Lerp(next.SunIntensity, 0.12f, 0.7f);
            }

            if (festival)
            {
                next.Background = Color.Lerp(next.Background, Hex("#f0c898"), 0.18f);
                next.Fog = Color.Lerp(next.Fog, Hex("#e8c0a0"), 0.12f);
                next.AmbientColor = Color.Lerp(next.AmbientColor, Hex("#fff0d8"), 0.22f);
                next.HemiSky = Color.Lerp(next.HemiSky, Hex("#ffe8c8"), 0.2f);
                next.SunColor = Color.Lerp(next.SunColor, Hex("#ffe0a8"), 0.15f);
                next.SunIntensity = Mathf.Lerp(next.SunIntensity, next.SunIntensity + 0.15f, 0.25f);
            }

            return next;
        }

        private static Keyframe PaletteForHour(int hour)
        {
            float h = ((hour % 24) + 24) % 24;
            Keyframe from = Keyframes[Keyframes.Length - 1];
            Keyframe to = Keyframes[0];

            for (int i = 0; i < Keyframes.Length; i++)
            {
                Keyframe cur = Keyframes[i];
                Keyframe next = Keyframes[(i + 1) % Keyframes.Length];
                bool inSpan = next.Hour > cur.Hour
                    ? h >= cur.Hour && h < next.Hour
                    : h >= cur.Hour || h < next.Hour;
                if (inSpan)
                {
                    from = cur;
                    to = next;
                    break;
                }
            }

            float span = to.Hour > from.Hour ? to.Hour - from.Hour : 24 - from.Hour + to.Hour;
            float offset = h >= from.Hour ? h - from.Hour : 24 - from.Hour + h;
            float t = span > 0f ? offset / span : 0f;

            return new Keyframe
            {
                Hour = hour,
                Background = Color.Lerp(from.Background, to.Background, t),
                Fog = Color.Lerp(from.Fog, to.Fog, t),
                AmbientIntensity = Mathf.Lerp(from.AmbientIntensity, to.AmbientIntensity, t),
                AmbientColor = Color.Lerp(from.AmbientColor, to.AmbientColor, t),
                HemiSky = Color.Lerp(from.HemiSky, to.HemiSky, t),
                HemiGround = Color.Lerp(from.HemiGround, to.HemiGround, t),
                HemiIntensity = Mathf.Lerp(from.HemiIntensity, to.HemiIntensity, t),
                SunColor = Color.Lerp(from.SunColor, to.SunColor, t),
                SunIntensity = Mathf.Lerp(from.SunIntensity, to.SunIntensity, t),
                SunPosition = Vector3.Lerp(from.SunPosition, to.SunPosition, t),
            };
        }

        private static Color Hex(string hex)
        {
            if (ColorUtility.TryParseHtmlString(hex, out Color color))
            {
                return color;
            }

            return Color.white;
        }
    }
}
