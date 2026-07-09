using System.Collections.Generic;
using AgentTown.Simulation;
using AgentTown.Town;
using UnityEngine;
using UnityEngine.UIElements;

namespace AgentTown.UI
{
    /// <summary>
    /// UI Toolkit observer panel controller (§7 UiLayer, §11 Phase 1 scope). Binds
    /// <c>TownHud.uxml</c> elements to <see cref="SimulationSession"/>: run management (create /
    /// resume), tick control (advance / pause / resume), playback (prev / play / next / live /
    /// speed), residents roster + detail, and status / SSE indicators. P2/P3 panels are out of scope.
    ///
    /// <para>Assign <c>TownHud.uxml</c> as the <see cref="UIDocument"/> source in Editor (see the
    /// Editor-wiring checklist). Element names are the binding contract; this controller degrades
    /// gracefully (retries binding) if the visual tree is not ready on the first frame.</para>
    /// </summary>
    [RequireComponent(typeof(UIDocument))]
    [DisallowMultipleComponent]
    public sealed class TownHudController : MonoBehaviour
    {
        [Tooltip("Optional: applied at runtime if the UXML does not already link TownHud.uss.")]
        [SerializeField] private StyleSheet styleSheet;

        private static readonly (string name, float value)[] SpeedButtons =
        {
            ("speed-05", 0.5f), ("speed-1", 1f), ("speed-2", 2f), ("speed-4", 4f),
        };

        private UIDocument document;
        private SimulationSession session;
        private bool bound;

        private Label statusLabel;
        private Label tickLabel;
        private Label streamLabel;
        private Button createRunButton;
        private Button resumeRunButton;
        private TextField runIdField;
        private Button advanceButton;
        private Button pauseButton;
        private Button resumeTickButton;
        private Button prevButton;
        private Button playButton;
        private Button nextButton;
        private Button liveButton;
        private ScrollView residentsList;
        private VisualElement residentDetail;

        /// <summary>Point the controller at a session (defaults to the singleton).</summary>
        public void Bind(SimulationSession target)
        {
            Unsubscribe();
            session = target;
            Subscribe();
            if (bound)
            {
                RefreshAll();
            }
        }

        private void OnEnable()
        {
            document = GetComponent<UIDocument>();
            session ??= SimulationSession.Instance;
            Subscribe();
            TryBind();
        }

        private void OnDisable() => Unsubscribe();

        private void Update()
        {
            if (!bound)
            {
                TryBind();
            }
        }

        private void Subscribe()
        {
            if (session == null)
            {
                return;
            }

            session.OnStatusChanged += HandleStatusChanged;
            session.OnSnapshotApplied += HandleSnapshotApplied;
            session.OnPlaybackChanged += RefreshPlayback;
            session.OnSelectionChanged += RefreshResidents;
        }

        private void Unsubscribe()
        {
            if (session == null)
            {
                return;
            }

            session.OnStatusChanged -= HandleStatusChanged;
            session.OnSnapshotApplied -= HandleSnapshotApplied;
            session.OnPlaybackChanged -= RefreshPlayback;
            session.OnSelectionChanged -= RefreshResidents;
        }

        private void TryBind()
        {
            if (document == null)
            {
                return;
            }

            VisualElement root = document.rootVisualElement;
            createRunButton = root?.Q<Button>("create-run-button");
            if (createRunButton == null)
            {
                return; // visual tree not ready yet — retry next frame
            }

            if (styleSheet != null && !root.styleSheets.Contains(styleSheet))
            {
                root.styleSheets.Add(styleSheet);
            }

            statusLabel = root.Q<Label>("status-label");
            tickLabel = root.Q<Label>("tick-label");
            streamLabel = root.Q<Label>("stream-label");
            resumeRunButton = root.Q<Button>("resume-run-button");
            runIdField = root.Q<TextField>("run-id-field");
            advanceButton = root.Q<Button>("advance-button");
            pauseButton = root.Q<Button>("pause-button");
            resumeTickButton = root.Q<Button>("resume-tick-button");
            prevButton = root.Q<Button>("prev-button");
            playButton = root.Q<Button>("play-button");
            nextButton = root.Q<Button>("next-button");
            liveButton = root.Q<Button>("live-button");
            residentsList = root.Q<ScrollView>("residents-list");
            residentDetail = root.Q<VisualElement>("resident-detail");

            WireButtons();
            bound = true;
            RefreshAll();
        }

        private void WireButtons()
        {
            createRunButton.clicked += () => _ = session.CreateRunAsync();
            if (resumeRunButton != null)
            {
                resumeRunButton.clicked += () => _ = session.AttachToRunAsync(runIdField?.value?.Trim() ?? "");
            }

            if (advanceButton != null) advanceButton.clicked += () => _ = session.AdvanceTickAsync();
            if (pauseButton != null) pauseButton.clicked += () => _ = session.PauseRunAsync();
            if (resumeTickButton != null) resumeTickButton.clicked += () => _ = session.ResumeRunAsync();

            if (prevButton != null) prevButton.clicked += () => session.StepPlaybackTick(-1);
            if (nextButton != null) nextButton.clicked += () => session.StepPlaybackTick(1);
            if (liveButton != null) liveButton.clicked += () => session.GoLive();
            if (playButton != null) playButton.clicked += TogglePlay;

            foreach ((string speedName, float value) in SpeedButtons)
            {
                Button button = document.rootVisualElement.Q<Button>(speedName);
                if (button != null)
                {
                    button.clicked += () => session.SetPlaybackSpeed(value);
                }
            }
        }

        private void TogglePlay()
        {
            if (session.Playing)
            {
                session.SetPlaying(false);
                return;
            }

            // Entering playback from live starts a replay at the first tick (mirrors Desktop / UE).
            if (session.IsLive && session.Tick >= 1)
            {
                session.SeekTick(1);
            }

            session.SetPlaying(true);
        }

        // ---- refresh ----

        private void HandleStatusChanged(string _) => RefreshStatus();

        private void HandleSnapshotApplied()
        {
            RefreshStatus();
            RefreshResidents();
        }

        private void RefreshAll()
        {
            RefreshStatus();
            RefreshPlayback();
            RefreshResidents();
        }

        private void RefreshStatus()
        {
            if (!bound || session == null)
            {
                return;
            }

            if (statusLabel != null)
            {
                statusLabel.text = session.StatusMessage;
            }

            bool hasRun = !string.IsNullOrEmpty(session.RunId);
            bool busy = session.Ticking;

            createRunButton?.SetEnabled(!busy);
            resumeRunButton?.SetEnabled(!busy);
            advanceButton?.SetEnabled(hasRun && !busy);
            pauseButton?.SetEnabled(hasRun);
            resumeTickButton?.SetEnabled(hasRun);
            prevButton?.SetEnabled(hasRun);
            playButton?.SetEnabled(hasRun);
            nextButton?.SetEnabled(hasRun);
            liveButton?.SetEnabled(hasRun);
        }

        private void RefreshPlayback()
        {
            if (!bound || session == null)
            {
                return;
            }

            if (tickLabel != null)
            {
                string mode = session.IsLive ? "Live" : "Replay";
                string playing = session.Playing ? " ▶" : "";
                tickLabel.text = $"Tick {session.DisplayTick} / {session.Tick} ({mode}{playing}) · {session.PlaybackSpeed:0.#}x";
            }

            if (streamLabel != null)
            {
                streamLabel.text = $"SSE: {session.StreamStatus}";
            }

            if (playButton != null)
            {
                playButton.text = session.Playing ? "⏸" : "▶";
            }

            foreach ((string speedName, float value) in SpeedButtons)
            {
                Button button = document.rootVisualElement?.Q<Button>(speedName);
                button?.EnableInClassList("active", Mathf.Approximately(value, session.PlaybackSpeed));
            }

            RefreshStatus();
        }

        private void RefreshResidents()
        {
            if (!bound || session == null || residentsList == null)
            {
                return;
            }

            residentsList.Clear();
            List<ResidentView> residents = TownResidents.Build(session);
            string selectedId = session.SelectedAgentId;

            foreach (ResidentView resident in residents)
            {
                residentsList.Add(BuildResidentRow(resident, resident.AgentId == selectedId));
            }

            RefreshDetail(selectedId, residents);
        }

        private VisualElement BuildResidentRow(ResidentView resident, bool selected)
        {
            var row = new VisualElement { name = $"resident-{resident.AgentId}" };
            row.AddToClassList("resident-row");
            if (selected)
            {
                row.AddToClassList("selected");
            }

            var nameLabel = new Label(resident.Name);
            nameLabel.AddToClassList("resident-name");

            string meta = resident.Role;
            if (!string.IsNullOrEmpty(resident.Location))
            {
                meta = string.IsNullOrEmpty(meta) ? resident.Location : $"{meta} · {resident.Location}";
            }

            var metaLabel = new Label(meta);
            metaLabel.AddToClassList("resident-meta");

            row.Add(nameLabel);
            row.Add(metaLabel);
            row.RegisterCallback<ClickEvent>(_ => SelectResident(resident.AgentId));
            return row;
        }

        private void SelectResident(string agentId)
        {
            bool alreadySelected = session.SelectedAgentId == agentId;
            session.SetSelectedAgent(alreadySelected ? null : agentId);
            session.SetTrackedAgent(alreadySelected ? null : agentId);
        }

        private void RefreshDetail(string selectedId, List<ResidentView> residents)
        {
            if (residentDetail == null)
            {
                return;
            }

            residentDetail.Clear();

            ResidentView selected = null;
            if (!string.IsNullOrEmpty(selectedId))
            {
                foreach (ResidentView resident in residents)
                {
                    if (resident.AgentId == selectedId)
                    {
                        selected = resident;
                        break;
                    }
                }
            }

            if (selected == null)
            {
                var hint = new Label("选择一位居民查看人设与状态。");
                hint.AddToClassList("detail-hint");
                residentDetail.Add(hint);
                return;
            }

            var title = new Label(selected.Name);
            title.AddToClassList("detail-title");
            residentDetail.Add(title);

            var sub = new Label(string.IsNullOrEmpty(selected.Location)
                ? selected.Role
                : $"{selected.Role} · {selected.Location}");
            sub.AddToClassList("detail-sub");
            residentDetail.Add(sub);

            if (!string.IsNullOrEmpty(selected.Bio))
            {
                var bio = new Label(selected.Bio);
                bio.AddToClassList("detail-bio");
                residentDetail.Add(bio);
            }

            residentDetail.Add(DetailLine("目标", string.IsNullOrEmpty(selected.Goal) ? "—" : selected.Goal));
            if (selected.HasLiveState)
            {
                residentDetail.Add(DetailLine("情绪", $"{MoodLabel(selected.Mood)} ({selected.Mood:0.00})"));
                residentDetail.Add(DetailLine("金钱", selected.Money.ToString("0")));
                residentDetail.Add(DetailLine("活动", string.IsNullOrEmpty(selected.Activity) ? "—" : selected.Activity));
            }

            AddTrait(selected, "开放性", selected.BigFive.Openness);
            AddTrait(selected, "尽责性", selected.BigFive.Conscientiousness);
            AddTrait(selected, "外向性", selected.BigFive.Extraversion);
            AddTrait(selected, "宜人性", selected.BigFive.Agreeableness);
            AddTrait(selected, "神经质", selected.BigFive.Neuroticism);
        }

        private static VisualElement DetailLine(string key, string value)
        {
            var line = new VisualElement();
            line.AddToClassList("detail-line");

            var keyLabel = new Label(key);
            keyLabel.AddToClassList("detail-key");
            var valueLabel = new Label(value);
            valueLabel.AddToClassList("detail-value");

            line.Add(keyLabel);
            line.Add(valueLabel);
            return line;
        }

        private void AddTrait(ResidentView _, string label, double value)
        {
            var row = new VisualElement();
            row.AddToClassList("trait-row");

            var labelEl = new Label(label);
            labelEl.AddToClassList("trait-label");

            var track = new VisualElement();
            track.AddToClassList("trait-track");
            var fill = new VisualElement();
            fill.AddToClassList("trait-fill");
            fill.style.width = Length.Percent(Mathf.Clamp01((float)value) * 100f);
            track.Add(fill);

            row.Add(labelEl);
            row.Add(track);
            residentDetail.Add(row);
        }

        private static string MoodLabel(double mood)
        {
            if (mood >= 0.5) return "愉快";
            if (mood >= 0.15) return "平静";
            if (mood >= -0.15) return "一般";
            if (mood >= -0.5) return "低落";
            return "沮丧";
        }
    }
}
