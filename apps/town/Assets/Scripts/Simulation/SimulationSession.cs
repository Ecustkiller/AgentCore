using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AgentTown.Simulation
{
    /// <summary>
    /// Client-side session state — the single source of truth for UI + 3D (UT-01). Faithful
    /// port of the retired UE <c>FSimulationSession</c>, adapted to async/await + Unity.
    /// Implements the §4 state fields, §4.2 mode rules, §4.3 ApplySnapshot pipeline and the
    /// §6.6 SSE event table (including ignoring <c>sim.tick_frame</c>).
    ///
    /// <para><b>Live vs Replay</b> (§4.2): Live consumes SSE and, on <c>tick_ended</c>, pulls
    /// the frame via <c>GET /ticks/{n}</c> (never applies the advance response snapshot
    /// directly). Replay ignores world-state SSE and only pulls frames via GET.</para>
    ///
    /// <para>Drive it from a MonoBehaviour: call <see cref="Update"/> each frame (it polls the
    /// SSE queue and advances playback). All public mutators must be called on the main thread.</para>
    /// </summary>
    public sealed class SimulationSession
    {
        public enum ClientMode
        {
            Live,
            Replay,
        }

        private const int MaxDecisions = 50;
        private const int MaxTickEvents = 400;
        private const float BasePlaybackStepSec = 0.6f;
        private const int MinPlaybackTick = 1;

        private static SimulationSession instance;

        /// <summary>Process-wide singleton (mirrors the UE reference). Tests may also <c>new</c> a fresh instance.</summary>
        public static SimulationSession Instance => instance ??= new SimulationSession();

        private readonly SimulationRestClient rest = new();
        private readonly SimulationSseClient sse = new();

        private Dictionary<string, SimAgentState> agents = new();
        private readonly Dictionary<string, Vector3> agentUnityPositions = new();
        private readonly Dictionary<int, SimTickSnapshot> tickCache = new();
        private readonly List<SimDecision> decisions = new();
        private readonly List<SimTickEvent> tickEvents = new();

        private string apiBase = "";
        private string accessToken = "";
        private bool ticking;
        private bool playing;
        private int seekGeneration;
        private float playbackAccumulator;
        private string selectedAgentId;
        private string trackedAgentId;

        public SimulationSession()
        {
            sse.OnEvent += HandleSseEvent;
            sse.OnStreamStatusChanged += HandleStreamStatus;
        }

        // ---- §4.1 state fields ----

        public ClientMode Mode { get; private set; } = ClientMode.Live;
        public string RunId { get; private set; } = "";
        public string Scenario { get; private set; } = "town";
        public string Status { get; private set; } = "";
        public string StatusMessage { get; private set; } = "";
        public int Tick { get; private set; }
        public int Hour { get; private set; }
        public bool Ticking => ticking;
        public int? Playhead { get; private set; }
        public bool Playing => playing;
        public float PlaybackSpeed { get; private set; } = 1f;
        public RunManifest Manifest { get; private set; } = new();
        public string StreamStatus => sse.StreamStatus;
        public string SelectedAgentId => selectedAgentId;
        public string TrackedAgentId => trackedAgentId;

        public IReadOnlyDictionary<string, SimAgentState> Agents => agents;
        public IReadOnlyDictionary<string, Vector3> AgentUnityPositions => agentUnityPositions;
        public IReadOnlyList<SimDecision> Decisions => decisions;
        public IReadOnlyList<SimTickEvent> TickEvents => tickEvents;
        public IReadOnlyDictionary<int, SimTickSnapshot> TickCache => tickCache;

        public int DisplayTick => Playhead ?? Tick;
        public bool IsLive => Mode == ClientMode.Live && Playhead == null;
        public bool IsReplayActive => Mode == ClientMode.Replay || Playhead != null;

        // ---- events (UI + 3D subscribe) ----

        public event Action OnSnapshotApplied;
        public event Action<string> OnStatusChanged;
        public event Action OnPlaybackChanged;
        public event Action OnDecisionsChanged;
        public event Action OnEventsChanged;
        public event Action OnSelectionChanged;

        // ---- lifecycle ----

        public void Configure(string apiBaseUrl, string token, string initialRunId = "")
        {
            apiBase = TrimTrailingSlashes(apiBaseUrl ?? "");
            accessToken = token ?? "";
            rest.Configure(apiBase, accessToken);
            sse.Configure(apiBase, accessToken, initialRunId ?? "");

            if (!string.IsNullOrEmpty(initialRunId))
            {
                RunId = initialRunId;
                SetStatusMessage($"Resuming run {RunId}");
            }
            else
            {
                SetStatusMessage($"API: {apiBase}");
            }
        }

        public void Reset()
        {
            DisconnectStream();

            Mode = ClientMode.Live;
            RunId = "";
            Scenario = "town";
            Status = "";
            Tick = 0;
            Hour = 0;
            ticking = false;
            Playhead = null;
            playing = false;
            PlaybackSpeed = 1f;
            seekGeneration = 0;
            playbackAccumulator = 0f;
            agents = new Dictionary<string, SimAgentState>();
            agentUnityPositions.Clear();
            tickCache.Clear();
            decisions.Clear();
            tickEvents.Clear();
            Manifest = new RunManifest();
            selectedAgentId = null;
            trackedAgentId = null;

            SetStatusMessage("Session reset");
            NotifyPlaybackChanged();
        }

        /// <summary>Per-frame pump: drain SSE queue then advance auto-playback. Call from MonoBehaviour.Update.</summary>
        public void Update(float deltaTime)
        {
            sse.Poll();
            UpdatePlayback(deltaTime);
        }

        // ---- §4.3 ApplySnapshot ----

        public void ApplySnapshot(SimTickSnapshot snapshot)
        {
            if (snapshot == null)
            {
                return;
            }

            Tick = snapshot.Tick;
            Hour = snapshot.Hour;

            // Copy (Dictionary assignment aliases; a copy keeps the cached frame immutable).
            agents = snapshot.Agents != null
                ? new Dictionary<string, SimAgentState>(snapshot.Agents)
                : new Dictionary<string, SimAgentState>();

            agentUnityPositions.Clear();
            foreach (KeyValuePair<string, SimAgentState> pair in agents)
            {
                WireVec3 wire = pair.Value != null ? pair.Value.Position : default;
                agentUnityPositions[pair.Key] = WireCoordinateTransform.ToUnity(wire);
            }

            CacheSnapshot(snapshot.Tick, snapshot);

            string modeLabel = IsReplayActive ? "Replay" : "Live";
            SetStatusMessage($"{modeLabel} — Tick {Tick} (hour {Hour}) — {agents.Count} agents");
            OnSnapshotApplied?.Invoke();
        }

        // ---- run control (§5) ----

        public async Task<bool> CreateRunAsync()
        {
            SetStatusMessage("Creating run…");
            SimulationRunSummary summary = await rest.CreateRunAsync(Scenario);
            if (summary == null)
            {
                SetStatusMessage($"Create run failed: {rest.LastError}");
                return false;
            }

            RunId = summary.Id;
            Status = summary.Status;
            Scenario = string.IsNullOrEmpty(summary.Scenario) ? Scenario : summary.Scenario;
            Tick = summary.CurrentTick;
            Hour = 0;
            Mode = ClientMode.Live;
            Playhead = null;
            playing = false;
            agents = new Dictionary<string, SimAgentState>();
            agentUnityPositions.Clear();
            tickCache.Clear();
            decisions.Clear();
            tickEvents.Clear();
            Manifest = new RunManifest();
            NotifyPlaybackChanged();

            SetStatusMessage($"Run {RunId} created (tick {Tick})");
            OnSnapshotApplied?.Invoke();

            await BootstrapActiveRunAsync();
            return true;
        }

        public async Task<bool> AdvanceTickAsync()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                SetStatusMessage("No run — create a run first");
                return false;
            }

            if (IsReplayActive)
            {
                await GoLiveAsync();
            }

            ticking = true;
            SetStatusMessage("Advancing tick…");

            // Per §4.2 we do NOT apply the advance response snapshot directly — the Live
            // frame arrives via SSE tick_ended → GET /ticks/{n}.
            AdvanceTickResponse result = await rest.AdvanceTickAsync(RunId);
            if (result == null)
            {
                ticking = false;
                SetStatusMessage($"Advance tick failed: {rest.LastError}");
                return false;
            }

            SetStatusMessage("Waiting for tick to complete…");
            return true;
        }

        public async Task<bool> LoadTickAsync(int tickNumber)
        {
            EnterReplay(tickNumber);
            ticking = true;
            SetStatusMessage($"Loading tick {tickNumber}…");
            bool ok = await FetchAndApplyTickAsync(tickNumber, updatePlayhead: true);
            ticking = false;
            return ok;
        }

        public Task<bool> FetchLiveTickAsync(int tickNumber)
        {
            Mode = ClientMode.Live;
            Playhead = null;
            NotifyPlaybackChanged();
            return FetchAndApplyTickAsync(tickNumber, updatePlayhead: false);
        }

        public async Task<bool> PauseRunAsync()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return false;
            }

            SimulationRunStatusResponse result = await rest.PauseRunAsync(RunId);
            if (result == null)
            {
                SetStatusMessage($"Pause failed: {rest.LastError}");
                return false;
            }

            Status = result.Status;
            SetStatusMessage($"Run paused (tick {result.CurrentTick})");
            NotifyPlaybackChanged();
            return true;
        }

        public async Task<bool> ResumeRunAsync()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return false;
            }

            SimulationRunStatusResponse result = await rest.ResumeRunAsync(RunId);
            if (result == null)
            {
                SetStatusMessage($"Resume failed: {rest.LastError}");
                return false;
            }

            Status = result.Status;
            SetStatusMessage($"Run resumed (tick {result.CurrentTick})");
            NotifyPlaybackChanged();
            return true;
        }

        /// <summary>
        /// Attach to an existing run by id (Run management "resume" — §11 SimulationRunManager).
        /// Additive helper composed from existing operations: clears the current run view (keeping
        /// the configured API/token), points at <paramref name="runId"/>, fetches the manifest,
        /// connects the live stream, and best-effort loads the first frame (live SSE then advances).
        /// Does not alter the §4.2 mode rules or §4.3 pipeline.
        /// </summary>
        public async Task<bool> AttachToRunAsync(string runId)
        {
            if (string.IsNullOrEmpty(runId))
            {
                SetStatusMessage("Enter a run id to resume");
                return false;
            }

            if (string.IsNullOrEmpty(apiBase))
            {
                SetStatusMessage("Configure API before resuming");
                return false;
            }

            Reset(); // clears run view + disconnects old stream; keeps apiBase/accessToken
            RunId = runId;
            SetStatusMessage($"Resuming run {runId}…");

            await BootstrapActiveRunAsync();
            await FetchLiveTickAsync(1);
            return true;
        }

        public async Task<bool> FetchManifestAsync()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return false;
            }

            SimulationRunManifestResponse result = await rest.GetManifestAsync(RunId);
            if (result == null)
            {
                SetStatusMessage($"Manifest failed: {rest.LastError}");
                return false;
            }

            Manifest = result.Manifest ?? new RunManifest();
            SetStatusMessage($"Manifest loaded — {Manifest.Personas.Count} residents");
            OnSnapshotApplied?.Invoke();
            return true;
        }

        public async Task BootstrapActiveRunAsync()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return;
            }

            await FetchManifestAsync();
            ConnectStream();
        }

        public void BootstrapActiveRun() => FireAndForget(BootstrapActiveRunAsync());

        // ---- playback (§4.2) ----

        public async Task GoLiveAsync()
        {
            seekGeneration++;
            Mode = ClientMode.Live;
            Playhead = null;
            playing = false;
            playbackAccumulator = 0f;
            NotifyPlaybackChanged();

            if (string.IsNullOrEmpty(RunId))
            {
                return;
            }

            if (Tick > 0)
            {
                await FetchAndApplyTickAsync(Tick, updatePlayhead: false);
            }
            else
            {
                SetStatusMessage("Live — waiting for first tick");
            }
        }

        public void GoLive() => FireAndForget(GoLiveAsync());

        public async Task SeekTickAsync(int targetTick)
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return;
            }

            if (targetTick >= Tick && Tick > 0)
            {
                await GoLiveAsync();
                return;
            }

            seekGeneration++;
            int generation = seekGeneration;
            EnterReplay(targetTick);

            if (tickCache.TryGetValue(targetTick, out SimTickSnapshot cached))
            {
                ApplySnapshot(cached);
                return;
            }

            bool ok = await FetchAndApplyTickAsync(targetTick, updatePlayhead: true);
            if (!ok || generation != seekGeneration)
            {
                // Superseded by a newer seek / go-live — drop this result.
            }
        }

        public void SeekTick(int targetTick) => FireAndForget(SeekTickAsync(targetTick));

        public void StepPlaybackTick(int delta)
        {
            SetPlaying(false);

            int tail = Tick;
            int current = Playhead ?? tail;
            int next = current + delta;

            if (next < MinPlaybackTick)
            {
                return;
            }

            if (next >= tail)
            {
                GoLive();
                return;
            }

            SeekTick(next);
        }

        public void SetPlaying(bool value)
        {
            playing = value;
            if (!playing)
            {
                playbackAccumulator = 0f;
            }

            NotifyPlaybackChanged();
        }

        public void SetPlaybackSpeed(float speed)
        {
            PlaybackSpeed = speed;
            NotifyPlaybackChanged();
        }

        public void UpdatePlayback(float deltaTime)
        {
            if (!playing || string.IsNullOrEmpty(RunId))
            {
                return;
            }

            playbackAccumulator += deltaTime;
            float interval = BasePlaybackStepSec / Mathf.Max(PlaybackSpeed, 0.1f);
            if (playbackAccumulator < interval)
            {
                return;
            }

            playbackAccumulator = 0f;

            int tail = Tick;
            int current = Playhead ?? tail;
            int next = current + 1;

            if (next > tail)
            {
                SetPlaying(false);
                GoLive();
                return;
            }

            SeekTick(next);
        }

        // ---- selection ----

        public void SetSelectedAgent(string agentId)
        {
            selectedAgentId = agentId;
            OnSelectionChanged?.Invoke();
        }

        public void SetTrackedAgent(string agentId)
        {
            trackedAgentId = agentId;
            OnSelectionChanged?.Invoke();
        }

        // ---- internals ----

        private async Task<bool> FetchAndApplyTickAsync(int tickNumber, bool updatePlayhead)
        {
            if (string.IsNullOrEmpty(RunId))
            {
                SetStatusMessage("No run — create a run first");
                return false;
            }

            if (tickCache.TryGetValue(tickNumber, out SimTickSnapshot cached))
            {
                if (updatePlayhead && IsReplayActive)
                {
                    Playhead = tickNumber;
                    NotifyPlaybackChanged();
                }

                ApplySnapshot(cached);
                return true;
            }

            SimTickFrameResponse frame = await rest.GetTickSnapshotAsync(RunId, tickNumber);
            if (frame == null)
            {
                ticking = false;
                SetStatusMessage($"Load tick failed: {rest.LastError}");
                return false;
            }

            if (updatePlayhead && IsReplayActive)
            {
                Playhead = tickNumber;
                NotifyPlaybackChanged();
            }

            ApplySnapshot(frame.Snapshot);
            return true;
        }

        private void ConnectStream()
        {
            if (string.IsNullOrEmpty(RunId))
            {
                return;
            }

            sse.Configure(apiBase, accessToken, RunId);
            sse.Connect();
        }

        private void DisconnectStream() => sse.Disconnect();

        private void EnterReplay(int targetTick)
        {
            Mode = ClientMode.Replay;
            Playhead = targetTick;
            NotifyPlaybackChanged();
        }

        private void CacheSnapshot(int tickNumber, SimTickSnapshot snapshot) => tickCache[tickNumber] = snapshot;

        private void SetStatusMessage(string message)
        {
            StatusMessage = message;
            OnStatusChanged?.Invoke(message);
        }

        private void NotifyPlaybackChanged() => OnPlaybackChanged?.Invoke();

        // ---- §6.6 SSE dispatch ----

        private void HandleSseEvent(SimSseEvent evt)
        {
            if (evt == null || string.IsNullOrEmpty(RunId))
            {
                return;
            }

            // §6.6: always ignore tick_frame to avoid a double path with tick_ended.
            if (evt.Type == "sim.tick_frame")
            {
                return;
            }

            // §4.2: in Replay / scrubbed playhead, ignore world-state-changing SSE.
            if (IsReplayActive)
            {
                return;
            }

            switch (evt.Type)
            {
                case "sim.tick_started":
                    HandleTickStarted(evt.Payload);
                    PushTickEvent(evt);
                    break;
                case "sim.tick_ended":
                    HandleTickEnded(evt.Payload);
                    PushTickEvent(evt);
                    break;
                case "sim.agent_action":
                    HandleAgentAction(evt.Payload);
                    PushTickEvent(evt);
                    break;
                case "sim.agent_state":
                    HandleAgentState(evt.Payload);
                    PushTickEvent(evt);
                    break;
                case "sim.interaction":
                case "sim.world_event":
                    PushTickEvent(evt);
                    break;
                default:
                    break;
            }
        }

        private void HandleStreamStatus(string status, string detail)
        {
            SetStatusMessage(string.IsNullOrEmpty(detail) ? $"SSE: {status}" : $"SSE: {status} — {detail}");
        }

        private void HandleTickStarted(JObject payload)
        {
            int startedTick = PayloadInt(payload, "tick");
            int startedHour = PayloadInt(payload, "hour");
            ticking = true;
            if (startedTick > 0)
            {
                Tick = startedTick;
            }

            if (startedHour > 0)
            {
                Hour = startedHour;
            }

            SetStatusMessage($"Tick {(startedTick > 0 ? startedTick : Tick)} started…");
        }

        private void HandleTickEnded(JObject payload)
        {
            int endedTick = PayloadInt(payload, "tick");
            int endedHour = PayloadInt(payload, "hour");
            ticking = false;
            Tick = Mathf.Max(Tick, endedTick);
            Hour = endedHour;

            if (IsReplayActive)
            {
                return;
            }

            seekGeneration++;
            int generation = seekGeneration;
            FireAndForget(FetchTickEndedAsync(endedTick, generation));
        }

        private async Task FetchTickEndedAsync(int endedTick, int generation)
        {
            bool ok = await FetchAndApplyTickAsync(endedTick, updatePlayhead: false);
            if (!ok || generation != seekGeneration || IsReplayActive)
            {
                // Superseded or entered replay meanwhile — result already dropped by ApplySnapshot guardrails.
            }
        }

        private void HandleAgentAction(JObject payload)
        {
            int eventTick = PayloadInt(payload, "tick");
            if (payload?["action"] is not JObject action)
            {
                return;
            }

            string agentId = PayloadString(action, "agent_id");
            string thought = PayloadString(action, "thought");
            string detail = PayloadString(action, "detail");
            string actionType = PayloadString(action, "action");

            string summary = thought.Trim();
            if (string.IsNullOrEmpty(summary))
            {
                summary = detail.Trim();
            }

            if (string.IsNullOrEmpty(summary))
            {
                summary = actionType;
            }

            string location = action["tool_args"] is JObject toolArgs
                ? PayloadString(toolArgs, "destination")
                : "";

            PushDecision(new SimDecision
            {
                Tick = eventTick,
                AgentId = agentId,
                Summary = summary,
                ActionType = actionType,
                Location = location,
            });
        }

        private void HandleAgentState(JObject payload)
        {
            if (payload?["state"] is not JObject stateObj)
            {
                return;
            }

            SimAgentState agent;
            try
            {
                agent = stateObj.ToObject<SimAgentState>(SimJson.Serializer);
            }
            catch (JsonException)
            {
                return;
            }

            if (agent == null || string.IsNullOrEmpty(agent.AgentId))
            {
                return;
            }

            agents[agent.AgentId] = agent;
            agentUnityPositions[agent.AgentId] = WireCoordinateTransform.ToUnity(agent.Position);
            OnSnapshotApplied?.Invoke();
        }

        private void PushDecision(SimDecision decision)
        {
            decisions.Insert(0, decision);
            if (decisions.Count > MaxDecisions)
            {
                decisions.RemoveRange(MaxDecisions, decisions.Count - MaxDecisions);
            }

            OnDecisionsChanged?.Invoke();
        }

        private void PushTickEvent(SimSseEvent evt)
        {
            tickEvents.Insert(0, new SimTickEvent
            {
                Tick = PayloadInt(evt.Payload, "tick"),
                Type = evt.Type,
                AgentId = ExtractEventAgentId(evt),
                Summary = evt.Type,
                Timestamp = evt.Timestamp,
            });

            if (tickEvents.Count > MaxTickEvents)
            {
                tickEvents.RemoveRange(MaxTickEvents, tickEvents.Count - MaxTickEvents);
            }

            OnEventsChanged?.Invoke();
        }

        private static string ExtractEventAgentId(SimSseEvent evt)
        {
            JObject payload = evt.Payload;
            if (payload == null)
            {
                return "";
            }

            if (payload["action"] is JObject action)
            {
                return PayloadString(action, "agent_id");
            }

            if (payload["state"] is JObject state)
            {
                return PayloadString(state, "agent_id");
            }

            return PayloadString(payload, "agent_id");
        }

        private static int PayloadInt(JObject payload, string key, int fallback = 0)
        {
            JToken token = payload?[key];
            if (token == null || token.Type == JTokenType.Null)
            {
                return fallback;
            }

            try
            {
                return token.Value<int>();
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static string PayloadString(JObject payload, string key, string fallback = "")
        {
            JToken token = payload?[key];
            if (token == null || token.Type == JTokenType.Null)
            {
                return fallback;
            }

            try
            {
                return token.Value<string>() ?? fallback;
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static async void FireAndForget(Task task)
        {
            try
            {
                await task;
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
        }

        private static string TrimTrailingSlashes(string value)
        {
            string result = value;
            while (result.EndsWith("/", StringComparison.Ordinal))
            {
                result = result.Substring(0, result.Length - 1);
            }

            return result;
        }
    }
}
